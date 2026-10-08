# Document ingestion: keep the original, work from Markdown

**Status:** proposal for Raj's sign-off (merging this PR = sign-off) · **Date:** 2026-10-08 · **Author:** Sisi
**Priority:** before Stage 2e, per Raj 2026-10-08. Foundation for the document-comparison fix and `create_matter`.

---

## 1. Problem

Every document that enters Audrey today loses its original and most of its structure.

| Way in | What's kept | Where |
|---|---|---|
| Pane upload button | plain text (mammoth raw text, read in the pane) | `documents` (41 rows) |
| Context Capture library | plain text (pdfjs / mammoth on the server); `original_content` is the extracted text, not the file | `matter_documents` (18 rows) |
| `upload_document` (Claude connector) | whatever text Claude passes | `documents` |

Searchable passages live in **three** separate indexes: `document_embeddings` (3,136), `matter_document_chunks` (537), and `matter_memory` chunks (800). There is no file storage bucket.

Consequences:
1. **No original.** We can't re-extract with a better tool, show the source of a citation, or prove what was uploaded.
2. **Structure lost.** Headings, tables and emphasis disappear. Word's automatic clause numbers ("12.3") are not text in the file, so raw extraction drops them. Audrey can't reliably cite clauses.
3. **Duplicated, inconsistent processing.** Each route extracts differently and indexes differently, and the chat reads the stores through different code paths (root cause of the OGES "library only holds KBR x2" answer).

## 2. Principles

1. **The original is kept, unchanged, forever** (until the user deletes the document).
2. **Convert once, at upload, to Markdown.** Everything downstream reads the Markdown: passages, position extraction, chat context, comparison, review.
3. **One way in.** All three routes call the same ingestion service.
4. **One document store and one passage index.**
5. **Never block on enrichment.** Storage and conversion succeed or fail cleanly; extraction and embedding follow asynchronously and self-heal via the daily sweep (AUD-606 principle).
6. **Clause numbers are first-class.** A converted Word document shows the numbers a lawyer sees in Word.

## 3. Design

### 3.1 Original file storage
- Supabase Storage, one **private** bucket `documents`. No public access; RLS denies all; only the service role reads/writes. Downloads via short-lived signed URLs issued by the backend after a firm check.
- Path: `{firm_id}/{matter_id | client:{client_id}}/{sha256}.{ext}`. Same bytes uploaded twice to the same matter = stored once.
- Limits: 25 MB per file; types .docx, .pdf, .txt, .md (others rejected with a clear message).
- Capacity: free tier gives 1 GB of storage. **Supabase Pro (100 GB) is a prerequisite for shipping** (also fixes pausing and backups — already recommended before pilot).

### 3.2 Schema (one migration, Raj runs it)
`documents` becomes the single document store. New columns:

| Column | Purpose |
|---|---|
| `client_id` | client-wide documents (absorbs the library's client scope); a row has a matter or a client, not both |
| `storage_path`, `file_sha256`, `mime_type`, `file_size` | the original |
| `markdown` | the working text (replaces `content` as the source of truth; `content` kept in sync during transition) |
| `conversion_method`, `conversion_version`, `conversion_warnings` | e.g. `docx-native@1`, `pdf-text@1`, `pdf-claude@1`, `legacy-text`; warnings such as "numbering partially resolved" |
| `tracked_changes` (jsonb) | insertions/deletions/comments found in the .docx (author, date, text), kept for later capture work; the Markdown is the accepted view |
| `document_role` | carried over from the library (supporting, precedent, transaction…) |

Firm-stamped at write like everything else. RLS stays deny-all for anon.

### 3.3 Conversion

**Word (.docx) — our own converter** (we already handle OOXML in the edit engine):
- Paragraph styles → Markdown headings; bold/italic/underline kept as emphasis.
- **Numbering resolved from the document's own numbering definitions** (levels, number formats such as `%1.%2`, start values, restarts, legal-style numbering) and written as text: `12.3 Limitation of liability`.
- Tables → Markdown tables (merged cells flattened, noted in warnings).
- Footnotes appended as `[^n]`; headers/footers dropped (noted).
- Tracked changes: Markdown shows the accepted text; the changes are recorded in `tracked_changes`.
- Fields (cross-references, dates) use their displayed result.

**PDF:**
1. Text extraction (pdfjs) with light layout rules: heading detection by font size/weight, numbered-clause detection by pattern, page markers kept as `<!-- page 7 -->` for citation.
2. **Fallback to Claude reading the PDF, page by page where needed.** Quality is judged per page: pages with good extracted text keep it; only poor pages (scanned, garbled, broken layout) go to Claude. Model `claude-sonnet-5-5`.
3. **No page cap — large documents are split automatically.** Pages sent to Claude go in batches of about 20 pages, with one page of overlap so a clause running across a batch boundary is captured whole. Each batch is told the last heading and clause number from the previous batch, so numbering stays continuous; the overlap is removed when the batches are stitched together. Smaller batches also transcribe more faithfully than one very large request. Batches run in parallel (limited concurrency) and a failed batch is retried on its own.
4. **Cost:** roughly 1p per page sent to Claude (a 50-page scanned contract ≈ 50p; a 400-page scanned bundle ≈ £4). Only an estimated cost above £10 for a single document asks the user to confirm first; everything else runs automatically.

**.txt / .md:** stored as-is (normalised line endings).

**Text-only input (`upload_document` from Claude):** the connector receives text, not files (MCP tool arguments are text). It goes through the same pipeline as a `.md` original; the "original" kept is that text. Claude is instructed to pass Markdown with clause numbers.

### 3.4 One ingestion service
- New endpoint on the legacy backend: `POST /api/ingest` (multipart: file + matter or client + role + optional note). Steps: firm check → hash → store original → convert → write `documents` row → queue an extraction job **immediately** (no waiting for the nightly sweep) → respond with the document id and any conversion warnings.
- The pane's upload button sends the **file** to this endpoint (instead of extracting text in the pane).
- Context Capture's library upload calls the same endpoint.
- The TCP `upload_document` tool writes through the same service (shared module or internal call).

### 3.5 One passage index
- Passages are produced by the extraction job from the **Markdown**, chunked on clause/heading boundaries where possible (not fixed character windows), each passage carrying its clause number and heading.
- Stored in `matter_memory` (`memory_type='chunk'`), embedded with `text-embedding-3-small`, maintained by the existing re-embed sweep. This is the index the connector already uses.
- The pane's chat search switches to this index. `document_embeddings` and `matter_document_chunks` are frozen, then retired once parity is confirmed.

### 3.6 What the chat reads
- Open document: unchanged (read live from Word).
- Other documents in the matter: their Markdown, under the comparison fix's rules (full text within a budget, clearly labelled as reference copies; passages beyond the budget) plus a names-only inventory of every matter and client document. That fix ships as the next step, on top of this.

## 4. Existing documents
The originals of the 59 existing documents were never kept and cannot be recovered.
- Migrate all `matter_documents` rows into `documents` (keeping matter/client scope and role); their text becomes `markdown` with `conversion_method = 'legacy-text'`.
- Re-index them into the single passage index.
- Produce a list of legacy documents for Raj; re-uploading any of them gains the original and proper Markdown (same name + matter → replaces the legacy row).

## 5. Acceptance tests
Fixture set: Raj's real contracts (KBR JDA, KBR MCA, OGES MOU v2.1 and v3.3, a scanned PDF, a document with tables, and a scanned PDF over 100 pages to prove the batch stitching: no duplicated or missing text at batch boundaries, numbering continuous).
1. **Clause-number fidelity:** for each .docx, compare the converter's numbers against Word's own (the pane reads each paragraph's displayed list number via Office.js). Target: 100% on the fixtures; any miss is a release blocker.
2. **Round trip:** original downloadable via signed URL; hash matches.
3. **Text fidelity:** converted text matches Word's visible text (excluding headers/footers) ≥ 99%.
4. **Size:** Markdown is no more than 1.3× the plain-text size.
5. **Retrieval:** the AUD-607 retrieval eval does not regress after switching the pane to the single index.
6. **No orphans:** every new upload has a row, a stored original, an extraction job queued within seconds.

## 6. Delivery
| Step | Content | Estimate |
|---|---|---|
| I1 | Bucket + migration + storage helpers | 0.5 day |
| I2 | .docx → Markdown converter with numbering, tables, tracked changes; fixtures and the clause-number test | 1–1.5 days |
| I3 | PDF path (text + Claude fallback) | 0.5 day |
| I4 | `/api/ingest`; pane, Context Capture and connector routed through it; immediate extraction | 0.5 day |
| I5 | Single passage index; pane search switched; library migration | 0.5–1 day |
| | **Total** | **3–4 days** |

Then: the comparison fix (≈0.5 day), then `create_client` / `create_matter` on the connector (≈0.5 day), then Stage 2e.

## 7. Decisions for Raj (sign-off checklist)
1. **`documents` absorbs the Context Capture library** (single store). Recommended: yes.
2. **`matter_memory` chunks become the only passage index.** Recommended: yes.
3. **Claude fallback for poor PDF pages**, about 1p per page, any length (auto-split into overlapping batches); confirmation only above an estimated £10 per document. Recommended: yes.
4. **Legacy documents** keep their text and are flagged for optional re-upload. Recommended: yes.
5. **Supabase Pro** before I1 ships to production. Required.
