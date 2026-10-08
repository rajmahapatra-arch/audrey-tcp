/**
 * upload_document — push a document into Audrey from the live chat.
 *
 * The missing piece for Claude-for-Word and Claude.ai surfaces: when
 * a lawyer attaches a file to the chat or has a Word document open,
 * the content lives in the LLM's session — NOT in Audrey. This tool
 * persists it into the documents table and queues extraction so
 * positions land in the matter immediately.
 *
 * Required: matter_id, name, content
 * Optional: doc_type, is_precedent (defaults to false)
 *
 * The handler:
 *   1. Inserts a new row in documents (service-role; bypasses RLS) in the
 *      ingestion shape (spec docs/document-ingestion-spec.md §3.3 "Text-only
 *      input"): the text IS the original, so markdown = content,
 *      conversion_method 'text', ingest_status 'converted', file_sha256 of
 *      the text, firm stamped. Same text into the same matter twice = the
 *      existing document (017's dedupe index). The text is also kept in
 *      the private `documents` bucket as .md, best-effort.
 *   2. Queues an extraction_jobs row pointing at the new document (drained
 *      within ~2 minutes by the prompt-extraction timer)
 *   3. Returns the document_id, queued job_id, and a friendly note
 *
 * The actual extraction runs async via the job runner. Tools that
 * query the matter (get_open_positions, etc.) will pick up the new
 * positions within ~30-90 seconds of extraction completion.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { queueExtractionJob } from '../extraction/jobRunner.js';

const text = (s: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(s) }],
});

let serviceClient: SupabaseClient | null | undefined;
function getServiceClient(): SupabaseClient | null {
  if (serviceClient !== undefined) return serviceClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    serviceClient = null;
    return null;
  }
  serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serviceClient;
}

// ============================================================
// Tool definition
// ============================================================

export const uploadDocumentTool: Tool = {
  name: 'upload_document',
  description:
    "Save document text into a matter's memory and queue position extraction (~30-90s; " +
    'content then surfaces via get_open_positions and search_matter_text). Use when the ' +
    'user asks to save/ingest/add a doc — chat attachments are otherwise forgotten when ' +
    'the session ends. Set is_precedent=true for firm standard forms.',
  inputSchema: {
    type: 'object',
    required: ['matter_id', 'name', 'content'],
    properties: {
      matter_id: {
        type: 'string',
        description:
          'UUID of the matter this document belongs to. If unknown, ' +
          'call list_matters or get_matter_by_document first.',
      },
      name: {
        type: 'string',
        description:
          'Human-readable filename, e.g. "KBR_JDA_v3.docx" or ' +
          '"Applied-KBR_SOW_2.pdf". Used for display and matching.',
      },
      content: {
        type: 'string',
        description:
          'The document text as Markdown: the full content as you can see it in ' +
          'the chat attachment or Word document, with headings as # lines and ' +
          'clause numbers written out as text (e.g. "12.3 Limitation of ' +
          'liability") — Audrey splits passages on them and cites them. Long ' +
          'docs (>100K chars) may be truncated by the extraction pipeline.',
      },
      doc_type: {
        type: 'string',
        description:
          'Optional category hint, e.g. "agreement", "amendment", "sow", ' +
          '"nda", "policy", "letter". Helps the extraction prompt orient.',
      },
      is_precedent: {
        type: 'boolean',
        description:
          'Set true when this is a firm precedent / standard form, not a ' +
          'matter-specific document. Default false.',
      },
      word_doc_id: {
        type: 'string',
        description:
          'Optional Office stable document identifier (the value of ' +
          'Word.context.document.url, when available). Pass this when ' +
          'invoked from a Word add-in surface so the document can be ' +
          'auto-resolved on subsequent get_matter_by_document calls. ' +
          'Omit when uploading from chat attachments or non-Word surfaces.',
      },
    },
  },
};

const UploadInput = z.object({
  matter_id: z.string().uuid(),
  name: z.string().min(1).max(500),
  content: z.string().min(20).max(500_000),
  doc_type: z.string().min(1).max(100).optional(),
  is_precedent: z.boolean().optional(),
  word_doc_id: z.string().min(1).max(2048).optional(),
});

// ============================================================
// Handler
// ============================================================

export async function handleUploadDocument(
  args: unknown,
  firmId: string,
  userId: string | null
) {
  const parsed = UploadInput.safeParse(args);
  if (!parsed.success) {
    return text({ error: parsed.error.message });
  }

  const db = getServiceClient();
  if (!db) {
    return text({
      error:
        'Document store unavailable — service role not configured. Operator should ' +
        'check SUPABASE_SERVICE_ROLE_KEY env var.',
    });
  }

  // 1. Validate the matter exists and belongs to this firm
  const { data: matter, error: matterErr } = await db
    .from('matters')
    .select('id, matter_name, firm_id')
    .eq('id', parsed.data.matter_id)
    .eq('firm_id', firmId)
    .maybeSingle();

  if (matterErr) {
    return text({ error: `Matter lookup failed: ${matterErr.message}` });
  }
  if (!matter) {
    return text({
      error:
        `Matter ${parsed.data.matter_id} not found in this firm. Use ` +
        `list_matters to find the correct UUID.`,
    });
  }

  // 2. Ingestion shape (017). Text input: the text is the original.
  const markdown = parsed.data.content.replace(/\r\n?/g, '\n');
  const fileSha256 = createHash('sha256').update(markdown, 'utf8').digest('hex');

  // Dedupe: same firm + matter + text = the existing document.
  const { data: existing, error: dupErr } = await db
    .from('documents')
    .select('id, name')
    .eq('firm_id', firmId)
    .eq('matter_id', parsed.data.matter_id)
    .eq('file_sha256', fileSha256)
    .limit(1)
    .maybeSingle();
  if (dupErr) {
    return text({ error: `Document lookup failed: ${dupErr.message}` });
  }
  if (existing) {
    return text({
      result: 'already_uploaded',
      document_id: (existing as { id: string }).id,
      matter_id: parsed.data.matter_id,
      matter_name: (matter as { matter_name: string | null }).matter_name,
      message:
        `This exact text is already saved in ${(matter as { matter_name: string | null }).matter_name ?? 'the matter'} ` +
        `as "${(existing as { name: string | null }).name ?? 'a document'}" — nothing new was added.`,
    });
  }

  // Keep the original (the text) in the private bucket — best-effort: the
  // Markdown column already holds it byte-for-byte, so a Storage hiccup
  // must not lose the upload.
  const storagePath = `${firmId}/${parsed.data.matter_id}/${fileSha256}.md`;
  let storedPath: string | null = null;
  try {
    const { error: upErr } = await db.storage
      .from('documents')
      .upload(storagePath, Buffer.from(markdown, 'utf8'), { contentType: 'text/markdown', upsert: true });
    if (upErr) console.warn('[audrey-upload] storing text original failed (kept in markdown):', upErr.message);
    else storedPath = storagePath;
  } catch (err) {
    console.warn('[audrey-upload] storing text original threw (kept in markdown):', err instanceof Error ? err.message : String(err));
  }

  // 3. Insert the document.
  //
  // word_doc_id is NULL when the upload didn't come from a Word add-in
  // surface (chat attachment, config-ui drag-and-drop, etc.). The
  // legacy NOT NULL constraint on this column was dropped in
  // migration 013; if you see "null value in column word_doc_id"
  // errors here, that migration hasn't been run yet.
  const { data: inserted, error: insertErr } = await db
    .from('documents')
    .insert({
      firm_id: firmId,
      matter_id: parsed.data.matter_id,
      name: parsed.data.name,
      content: markdown, // transition: existing readers still read `content`
      markdown,
      conversion_method: 'text',
      conversion_version: 1,
      conversion_warnings: [],
      ingest_status: 'converted',
      file_sha256: fileSha256,
      mime_type: 'text/markdown',
      file_size: Buffer.byteLength(markdown, 'utf8'),
      storage_path: storedPath,
      content_snapshot: new Date().toISOString(),
      doc_type: parsed.data.doc_type ?? null,
      is_precedent: parsed.data.is_precedent ?? false,
      word_doc_id: parsed.data.word_doc_id ?? null,
      user_id: userId,
      status: 'active',
      added_at: new Date().toISOString(),
      last_modified: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    return text({
      error: `Failed to save document: ${insertErr?.message ?? 'unknown'}`,
    });
  }

  const documentId = (inserted as { id: string }).id;

  // 4. Queue extraction so positions get populated
  let jobId: string | null = null;
  try {
    const { jobId: queuedJobId } = await queueExtractionJob({
      firmId,
      documentId,
      matterId: parsed.data.matter_id,
      triggeredBy: 'document_upload',
      triggeredByUser: userId,
    });
    jobId = queuedJobId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[audrey-upload] failed to queue extraction:', msg);
    // Non-fatal — document is saved; user can manually re-extract later
  }

  return text({
    result: 'uploaded',
    document_id: documentId,
    matter_id: parsed.data.matter_id,
    matter_name: (matter as { matter_name: string | null }).matter_name,
    extraction_job_id: jobId,
    extraction_status: jobId ? 'queued' : 'queue_failed',
    is_precedent: parsed.data.is_precedent ?? false,
    message:
      jobId
        ? `Saved to ${(matter as { matter_name: string | null }).matter_name ?? 'matter'}. ` +
          'Extraction is running in the background — positions will be available ' +
          'in 30-90 seconds via get_open_positions or search_matter_text.'
        : `Saved to ${(matter as { matter_name: string | null }).matter_name ?? 'matter'}, ` +
          'but extraction queueing failed. The document is preserved; ' +
          'extraction can be re-run manually.',
  });
}
