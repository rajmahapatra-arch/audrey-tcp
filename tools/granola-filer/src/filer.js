// dry-run / run orchestration.

import fs from 'node:fs';
import path from 'node:path';
import { files, log } from './config.js';
import { scanFolders, meetingsDir } from './folders.js';
import { decide, signalDomains } from './rules.js';
import { baseFileName, uniqueFileName, renderMeeting, BOM, ymdLocal } from './format.js';
import { buildDomainMap, detectMoves } from './learning.js';
import { loadState, saveState } from './state.js';
import { createClassifier } from './model.js';
import { makeProvider } from './connect.js';
import { openNonInteractive, NeedsReconnectError } from './granola.js';
import { GranolaApi } from './granola-api.js';
import { parseAccountInfo } from './parse.js';
import { showToast, toastText } from './toast.js';

const RULE_NAMES = {
  a: 'Granola folder',
  b: 'attendee domains',
  c: 'title',
  d: 'model',
  e: 'inbox',
};

/** Is the meeting ready to file? Summary must exist and the meeting must have ended >= N minutes ago. */
export function readiness(meeting, now, readyAfterMinutes) {
  if (!meeting.summary || !meeting.summary.trim()) return { ready: false, why: 'no Granola summary yet' };
  const gap = readyAfterMinutes * 60000;
  // Granola gives no end time. The note's last update (summary generation happens after the
  // meeting ends) is the best proxy; failing that, assume a meeting of up to an hour.
  let end = meeting.end;
  if (!end && meeting.updatedAt && (!meeting.start || meeting.updatedAt > meeting.start)) end = meeting.updatedAt;
  if (!end && meeting.start) end = new Date(meeting.start.getTime() + 60 * 60000);
  if (!end) return { ready: true, why: 'no time given; summary exists' };
  if (now - end < gap) return { ready: false, why: `ended less than ${readyAfterMinutes} minutes ago` };
  return { ready: true };
}

/** title -> "Grandparent / Parent / Title" for nested Granola folders (top-level folders map to themselves). */
export function granolaFolderPaths(gfolders) {
  const byId = new Map(gfolders.map((f) => [f.id, f]));
  const out = new Map();
  for (const f of gfolders) {
    const chain = [f.name];
    let p = f.parentId ? byId.get(f.parentId) : null;
    for (let i = 0; p && i < 5; i += 1) { chain.unshift(p.name); p = p.parentId ? byId.get(p.parentId) : null; }
    if (!out.has(f.name)) out.set(f.name, chain.join(' / '));
  }
  return out;
}

function acquireLock() {
  const lock = files.lock();
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs < 30 * 60000) return false;
  } catch { /* no lock */ }
  fs.writeFileSync(lock, String(process.pid));
  return true;
}
const releaseLock = () => { try { fs.unlinkSync(files.lock()); } catch { /* ignore */ } };

function relToRoot(config, p) {
  const rel = path.relative(config.clientRoot, p);
  return rel.startsWith('..') ? p : rel;
}

function appendFilingLog(config, line) {
  fs.mkdirSync(config.inbox, { recursive: true });
  const f = path.join(config.inbox, '_filing-log.txt');
  const exists = fs.existsSync(f);
  fs.appendFileSync(f, `${exists ? '' : BOM}${line}\r\n`, 'utf8');
}

/** Merge list + detail records. */
function merge(listed, detail) {
  if (!detail) return listed;
  const pick = (a, b) => (b !== undefined && b !== null && b !== '' ? b : a);
  return {
    ...listed,
    ...Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, pick(listed[k], v)])),
    attendees: detail.attendees?.length ? detail.attendees : listed.attendees,
    granolaFolders: [...new Set([...(listed.granolaFolders || []), ...(detail.granolaFolders || [])])],
  };
}

export async function runFiler(config, { dryRun = true, refile, toast = false, now = new Date() } = {}) {
  if (!dryRun && !acquireLock()) return { message: 'Another run is in progress; skipping.', exitCode: 0 };
  let g;
  try {
    const state = loadState(files.state());
    const work = structuredClone(state); // dry-run never saves this
    const counts = { listed: 0, alreadyDone: 0, notReady: 0, byRule: { a: 0, b: 0, c: 0, d: 0, e: 0 }, written: 0, newMatters: 0 };

    // 1. Learn from files Raj has moved since last time.
    const moves = detectMoves(work, config, { now });

    // 2. Folders on disk.
    const folders = scanFolders(config);

    // 3. Granola.
    const provider = makeProvider(config, { interactive: false });
    g = await openNonInteractive({ config, provider });
    const api = await GranolaApi.open(g);
    for (const name of ['list_meetings', 'get_meetings']) {
      if (!api.tools[name]) throw new Error(`Granola no longer offers the "${name}" tool`);
    }

    const acct = parseAccountInfo(await api.accountInfo());
    if (work.account?.workspace && acct.workspace && work.account.workspace !== acct.workspace) {
      const msg = `Paused: Granola's active workspace has changed from "${work.account.workspace}" to "${acct.workspace}". `
        + 'Switch back in the Granola app, or run "connect" to accept the new workspace. Nothing was filed.';
      log('paused: workspace changed');
      if (toast) await showToast('Granola Filer paused', 'Your Granola workspace has changed. Open Granola or run connect.');
      return { message: msg, exitCode: 2 };
    }
    if (!work.account && acct.workspace) work.account = { ...acct, recordedAt: now.toISOString() };

    const from = new Date(now.getTime() - config.lookbackDays * 86400000);
    const listed = await api.listMeetings({ from, to: now });

    // Granola lists each meeting's folders by title. Nested folders are expanded to
    // "Parent / Child" so a child named after a matter is read in its client's context.
    const gfolders = await api.folders();
    const fullName = granolaFolderPaths(gfolders);
    const folderOf = new Map();
    for (const m of listed) folderOf.set(m.id, new Set((m.granolaFolders || []).map((n) => fullName.get(n) || n)));

    let candidates = listed.filter((m) => !m.start || m.start >= from);
    counts.listed = candidates.length;
    if (refile) {
      if (work.meetings[refile]) {
        const old = work.meetings[refile];
        work.refiled = [...(work.refiled || []), { id: refile, at: now.toISOString(), previous: { path: old.path, client: old.client, matter: old.matter } }];
        delete work.meetings[refile];
      }
      if (!candidates.some((m) => m.id === refile)) candidates.push({ id: refile, attendees: [], granolaFolders: [] });
      candidates = candidates.filter((m) => m.id === refile);
    }
    const todo = candidates.filter((m) => {
      if (work.meetings[m.id]) { counts.alreadyDone += 1; return false; }
      return true;
    });

    const details = todo.length ? await api.getMeetings(todo.map((m) => m.id)) : new Map();
    const meetings = todo.map((m) => {
      const full = merge(m, details.get(m.id));
      const names = new Set([...(folderOf.get(m.id) || []), ...(details.get(m.id)?.granolaFolders || []).map((n) => fullName.get(n) || n)]);
      full.granolaFolders = [...names];
      return full;
    }).sort((x, y) => (x.start?.getTime() || 0) - (y.start?.getTime() || 0));

    const classifier = createClassifier(config);
    const plan = [];
    const toastCounts = { filed: 0, inbox: 0, newMatters: 0 };

    for (const m of meetings) {
      const r = readiness(m, now, config.readyAfterMinutes);
      const dateStr = m.start ? `${ymdLocal(m.start)} ${m.start.toTimeString().slice(0, 5)}` : 'undated';
      if (!r.ready) {
        counts.notReady += 1;
        plan.push({ m, dateStr, status: `WAITING (${r.why})` });
        log(`wait ${m.id} ${dateStr}: ${r.why}`);
        continue;
      }
      const domainMap = buildDomainMap(work);
      const d = await decide(m, { folders, domainMap, config, classifier });
      counts.byRule[d.rule] += 1;

      let dir;
      if (d.client) {
        const matter = d.newMatterName || d.matter;
        dir = meetingsDir(config, folders, d.client, matter);
      } else {
        dir = config.inbox;
      }
      const fileName = uniqueFileName(dir, baseFileName(m));
      const target = path.join(dir, fileName);
      plan.push({ m, dateStr, d, target });

      const record = {
        date: m.start ? m.start.toISOString() : null,
        fileName,
        path: target,
        client: d.client,
        matter: d.newMatterName || d.matter,
        rule: d.rule,
        decidedBy: `rule ${d.rule}`,
        confidence: d.confidence,
        domains: signalDomains(m.attendees, config),
        location: d.client ? 'filed' : 'inbox',
        writtenAt: now.toISOString(),
      };

      if (!dryRun) {
        if (d.newMatterName) {
          const c = folders.find((f) => f.name === d.client);
          const mp = path.join(c.path, d.newMatterName);
          if (!fs.existsSync(mp)) {
            fs.mkdirSync(mp);
            c.matters.push({ name: d.newMatterName, path: mp });
            toastCounts.newMatters += 1;
            log(`new matter folder created by model: ${relToRoot(config, mp)}`);
          }
        }
        fs.mkdirSync(dir, { recursive: true });
        const transcript = await api.transcript(m.id);
        fs.writeFileSync(target, BOM + renderMeeting(m, transcript), { encoding: 'utf8', flag: 'wx' });
        counts.written += 1;
        if (d.client) toastCounts.filed += 1; else toastCounts.inbox += 1;
        if (!d.client) {
          appendFilingLog(config, `${now.toISOString().slice(0, 16).replace('T', ' ')}  ${fileName}\r\n    Why it is here: ${d.reason}${d.suggestion ? `\r\n    Suggestion: ${d.suggestion}` : ''}`);
        }
        log(`filed ${m.id} ${dateStr} -> ${relToRoot(config, target).replace(fileName, '')} rule=${d.rule} conf=${d.confidence}`);
      }
      // Record in the working state either way, so later meetings in this run can learn from it.
      work.meetings[m.id] = record;
    }

    if (dryRun) {
      writePlan(config, { plan, counts, moves, now });
    } else {
      // Domain map is derived; store it for transparency.
      work.domains = buildDomainMap(work);
      work.lastRun = now.toISOString();
      saveState(files.state(), work);
      if (toast && (toastCounts.filed || toastCounts.inbox || toastCounts.newMatters)) {
        await showToast('Granola Filer', toastText(toastCounts));
      }
    }

    const ruleLine = Object.entries(counts.byRule).map(([k, v]) => `${k} (${RULE_NAMES[k]}): ${v}`).join(', ');
    const message = [
      `${dryRun ? 'Dry run' : 'Run'} complete. Meetings in the last ${config.lookbackDays} days: ${counts.listed}.`,
      `Already processed: ${counts.alreadyDone}. Waiting for Granola (not ready): ${counts.notReady}.`,
      `Decided by rule -- ${ruleLine}.`,
      `Moves detected: ${moves.moved} (to folders ${moves.toFiled}, back to inbox ${moves.toInbox}); missing files: ${moves.missing}.`,
      dryRun ? `Plan written to ${files.plan()} (no meeting files were written).` : `Files written: ${counts.written}.`,
      `Granola calls this run: ${g.calls}.`,
    ].join('\n');
    log(message.replace(/\n/g, ' | '));
    return { message, counts, moves, exitCode: 0 };
  } catch (e) {
    if (e instanceof NeedsReconnectError && toast) {
      await showToast('Granola Filer', 'Granola sign-in needed: run "connect".');
    }
    throw e;
  } finally {
    await g?.close();
    if (!dryRun) releaseLock();
  }
}

function writePlan(config, { plan, counts, moves, now }) {
  const lines = [
    `Granola Filer -- DRY RUN PLAN (${now.toLocaleString('en-GB')})`,
    'Nothing has been written. This file is only on this computer.',
    '',
    `Meetings in window: ${counts.listed}   already processed: ${counts.alreadyDone}   not ready: ${counts.notReady}`,
    `By rule: ${Object.entries(counts.byRule).map(([k, v]) => `${k}=${v}`).join('  ')}`,
    `Moves detected since last run: ${moves.moved}`,
    '',
    'Rules: a = Granola folder name, b = learned attendee domains, c = title, d = model, e = inbox',
    '',
  ];
  for (const p of plan) {
    lines.push(`${p.dateStr}  ${p.m.title || '(untitled)'}`);
    lines.push(`    Granola ID: ${p.m.id}`);
    if (p.status) {
      lines.push(`    ${p.status}`);
    } else {
      lines.push(`    -> ${relToRoot(config, p.target)}`);
      lines.push(`    rule ${p.d.rule} (${RULE_NAMES[p.d.rule]}), confidence ${p.d.confidence.toFixed(2)}: ${p.d.reason}`);
      if (p.d.suggestion) lines.push(`    suggestion: ${p.d.suggestion}`);
      if (p.d.newMatterName) lines.push('    (would create a NEW matter folder)');
    }
    lines.push('');
  }
  fs.writeFileSync(files.plan(), BOM + lines.join('\r\n'), 'utf8');
}

export function status(config) {
  const s = loadState(files.state());
  const recs = Object.values(s.meetings);
  const by = (k) => recs.reduce((acc, r) => ({ ...acc, [r[k]]: (acc[r[k]] || 0) + 1 }), {});
  return [
    `State: ${files.state()}`,
    `Workspace recorded: ${s.account?.workspace || '(none -- run connect)'}`,
    `Last run: ${s.lastRun || 'never'}`,
    `Meetings processed: ${recs.length}`,
    `  by location: ${JSON.stringify(by('location'))}`,
    `  by rule:     ${JSON.stringify(by('rule'))}`,
    `Learned domains: ${Object.keys(buildDomainMap(s)).length}`,
    `Inbox: ${config.inbox}`,
  ].join('\n');
}
