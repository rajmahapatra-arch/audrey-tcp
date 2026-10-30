// Filing rules. Each decision records which rule decided it and why.
//
//   a  Granola folder name matches a client or matter folder
//   b  learned attendee e-mail domains
//   c  meeting title contains a matter folder name or a distinctive client name
//   d  optional model classifier (off unless config.model.provider != "none")
//   e  inbox
//
// Reasons never include meeting content beyond folder names (which are Raj's own folder names).

import { norm, containsWords } from './folders.js';

/** Matter names too generic to trust in a title unless the client is already known. */
export const GENERIC_NAMES = new Set([
  // Common legal/business words. Firm-specific additions belong in config.json "genericNames"
  // (kept on the laptop, not in the repo).
  'nda', 'ndas', 'brand', 'insurance', 'employment', 'advisors', 'advisers', 'dpia', 'hr', 'general',
  'misc', 'miscellaneous', 'admin', 'meetings', 'contracts', 'corporate', 'commercial', 'litigation',
  'disputes', 'tax', 'property', 'ip', 'finance', 'licensing', 'board', 'shareholders', 'funding',
  'fundraising', 'investment', 'governance', 'policies', 'templates', 'terms', 'terms and conditions',
].map(norm));

export function emailDomain(email) {
  const m = String(email || '').toLowerCase().trim().match(/@([a-z0-9.-]+)$/);
  return m ? m[1].replace(/\.$/, '') : null;
}

/** Attendee domains that can carry client signal (own and webmail domains removed). */
export function signalDomains(attendees, config) {
  const skip = new Set([...(config.ownDomains || []), ...(config.genericDomains || [])].map((d) => d.toLowerCase()));
  const out = new Set();
  for (const a of attendees || []) {
    const d = emailDomain(a.email);
    if (!d) continue;
    if (skip.has(d) || [...skip].some((s) => d.endsWith(`.${s}`))) continue;
    out.add(d);
  }
  return [...out].sort();
}

function isDistinctiveName(name, config) {
  const n = norm(name);
  if (n.length < 4) return false;
  const generic = new Set([...GENERIC_NAMES, ...((config.genericNames || []).map(norm))]);
  return !generic.has(n);
}

/** Unique-ify a list of {client, matter} candidates. */
function uniq(cands) {
  const seen = new Map();
  for (const c of cands) seen.set(`${c.client}\u0000${c.matter ?? ''}`, c);
  return [...seen.values()];
}

/** Keep only the longest-named matches (so "Employment related" beats "Employment"). */
function longest(cands) {
  if (cands.length <= 1) return cands;
  const len = (c) => norm(c.matter ?? c.client).length;
  const max = Math.max(...cands.map(len));
  return cands.filter((c) => len(c) === max);
}

// ---------- Rule a: Granola folder ----------
/** Resolve a "Client" or "Client\\Matter" (or "/") string from config.folderMap against the disk folders. */
export function resolveMapped(target, folders) {
  const [cName, mName] = String(target).split(/[\\/]/).map((s) => s.trim()).filter(Boolean);
  const c = folders.find((f) => norm(f.name) === norm(cName));
  if (!c) return null;
  if (!mName) return { client: c.name, matter: null };
  const m = c.matters.find((x) => norm(x.name) === norm(mName));
  return m ? { client: c.name, matter: m.name } : null;
}

export function ruleGranolaFolder(meeting, folders, folderMap = {}) {
  const results = [];
  const mapNorm = Object.fromEntries(Object.entries(folderMap || {}).map(([k, v]) => [norm(k), v]));
  for (const g of meeting.granolaFolders || []) {
    const ng = norm(g);
    if (!ng) continue;
    let cands = [];
    // explicit mapping in config.json wins
    const leaf = norm(String(g).split(' / ').pop());
    const mapped = mapNorm[ng] ?? mapNorm[leaf];
    if (mapped) {
      const r = resolveMapped(mapped, folders);
      if (r) { results.push({ ...r, granolaFolder: g }); continue; }
    }
    // exact matter
    for (const c of folders) for (const m of c.matters) if (norm(m.name) === ng) cands.push({ client: c.name, matter: m.name });
    // exact client
    if (!cands.length) for (const c of folders) if (norm(c.name) === ng) cands.push({ client: c.name, matter: null });
    // matter name contained in the Granola folder name (prefer the client also named there)
    if (!cands.length) {
      let contained = [];
      for (const c of folders) for (const m of c.matters) if (containsWords(g, m.name)) contained.push({ client: c.name, matter: m.name });
      const withClient = contained.filter((x) => containsWords(g, x.client));
      if (withClient.length) contained = withClient;
      cands = longest(uniq(contained));
    }
    // client name contained in the Granola folder name
    if (!cands.length) for (const c of folders) if (containsWords(g, c.name)) cands.push({ client: c.name, matter: null });
    cands = uniq(cands);
    if (cands.length === 1) results.push({ ...cands[0], granolaFolder: g });
    else if (cands.length > 1) results.push({ ambiguous: cands, granolaFolder: g });
  }
  let decided = uniq(results.filter((r) => !r.ambiguous).map(({ client, matter }) => ({ client, matter })));
  // Same client from several folders: a single matter beats client level.
  if (decided.length > 1 && new Set(decided.map((d) => d.client)).size === 1) {
    const withMatter = decided.filter((d) => d.matter);
    if (withMatter.length === 1) decided = withMatter;
  }
  if (decided.length === 1) {
    return { client: decided[0].client, matter: decided[0].matter, reason: 'Granola folder name matches a client/matter folder' };
  }
  if (decided.length > 1) return { ambiguous: decided, reason: 'Meeting is in Granola folders that point to different client/matter folders' };
  const amb = results.find((r) => r.ambiguous);
  if (amb) return { ambiguous: amb.ambiguous, reason: 'Granola folder name matches more than one client/matter folder' };
  return null;
}

// ---------- Rule b: learned domains ----------
/**
 * domainMap: { [domain]: { clients: {client: n}, matters: {client: {matter: n}} } }
 * Client-level meetings are not counted in `matters`.
 */
export function ruleDomains(domains, domainMap) {
  const clientVotes = new Set();
  let conflict = false;
  for (const d of domains) {
    const e = domainMap[d];
    if (!e) continue;
    const clients = Object.keys(e.clients || {}).filter((c) => e.clients[c] > 0);
    if (clients.length === 1) clientVotes.add(clients[0]);
    else if (clients.length > 1) conflict = true; // a shared domain: no signal, but note it
  }
  if (clientVotes.size !== 1) {
    if (clientVotes.size > 1) return { ambiguous: [...clientVotes].map((c) => ({ client: c, matter: null })), reason: 'Attendee domains point to different clients' };
    return null;
  }
  const client = [...clientVotes][0];
  const matters = new Set();
  for (const d of domains) {
    const ms = domainMap[d]?.matters?.[client] || {};
    for (const [m, n] of Object.entries(ms)) if (n > 0) matters.add(m);
  }
  const matter = matters.size === 1 ? [...matters][0] : null;
  return {
    client,
    matter,
    reason: matter
      ? 'Attendee domain only seen with this client, and only with this matter'
      : `Attendee domain only seen with this client${conflict ? ' (other domains are shared)' : ''}`,
  };
}

// ---------- Rule c: title ----------
export function ruleTitle(title, folders, config, knownClient = null) {
  if (!title) return null;
  const clientsInTitle = folders.filter((c) => isDistinctiveName(c.name, config) && containsWords(title, c.name))
    .concat(folders.filter((c) => (config.clientAliases?.[c.name] || []).some((a) => containsWords(title, a))));
  const clientSet = [...new Set(clientsInTitle.map((c) => c.name))];
  const scopeClient = knownClient || (clientSet.length === 1 ? clientSet[0] : null);

  let matterHits = [];
  // config.matterAliases: { "Client\\Matter": ["Yasref", ...] } — names a matter goes by in titles.
  for (const [target, aliases] of Object.entries(config.matterAliases || {})) {
    const r = resolveMapped(target, folders);
    if (!r || (scopeClient && r.client !== scopeClient)) continue;
    if ((aliases || []).some((a) => containsWords(title, a))) matterHits.push(r);
  }
  for (const c of folders) {
    if (scopeClient && c.name !== scopeClient) continue;
    for (const m of c.matters) {
      if (!containsWords(title, m.name)) continue;
      // Generic matter names only count once the client is known.
      if (!scopeClient && !isDistinctiveName(m.name, config)) continue;
      matterHits.push({ client: c.name, matter: m.name });
    }
  }
  matterHits = longest(uniq(matterHits));
  if (matterHits.length === 1) return { ...matterHits[0], reason: 'Title contains a matter folder name' };
  if (matterHits.length > 1) {
    return scopeClient
      ? { client: scopeClient, matter: null, reason: 'Title names this client; several matters match so filed at client level', partial: true }
      : { ambiguous: matterHits, reason: 'Title contains several matter folder names' };
  }
  if (knownClient) return null;
  if (clientSet.length === 1) return { client: clientSet[0], matter: null, reason: 'Title contains the client name' };
  if (clientSet.length > 1) return { ambiguous: clientSet.map((c) => ({ client: c, matter: null })), reason: 'Title names several clients' };
  return null;
}

function describe(c) {
  return c.matter ? `${c.client} \\ ${c.matter}` : `${c.client} (client level)`;
}

/**
 * Decide where a meeting goes.
 * Returns { client, matter, newMatterName?, rule, confidence, reason, suggestion? }
 * with client === null meaning inbox.
 */
export async function decide(meeting, { folders, domainMap, config, classifier }) {
  const notes = [];

  const a = ruleGranolaFolder(meeting, folders, config.folderMap);
  if (a && !a.ambiguous) return { client: a.client, matter: a.matter, rule: 'a', confidence: 1, reason: a.reason };
  if (a?.ambiguous) notes.push(`${a.reason}: ${a.ambiguous.map(describe).join(' / ')}`);

  const domains = signalDomains(meeting.attendees, config);
  const b = ruleDomains(domains, domainMap);
  if (b && !b.ambiguous) {
    if (!b.matter) {
      const refine = ruleTitle(meeting.title, folders, config, b.client);
      if (refine && !refine.ambiguous && refine.matter) {
        return { client: b.client, matter: refine.matter, rule: 'b', confidence: 0.9, reason: `${b.reason}; matter from title` };
      }
    }
    return { client: b.client, matter: b.matter, rule: 'b', confidence: 0.9, reason: b.reason };
  }
  if (b?.ambiguous) notes.push(`${b.reason}: ${b.ambiguous.map(describe).join(' / ')}`);

  const c = ruleTitle(meeting.title, folders, config);
  if (c && !c.ambiguous) return { client: c.client, matter: c.matter, rule: 'c', confidence: 0.85, reason: c.reason };
  if (c?.ambiguous) notes.push(`${c.reason}: ${c.ambiguous.map(describe).join(' / ')}`);

  let suggestion;
  if (classifier) {
    try {
      const r = await classifier.classify({
        title: meeting.title,
        attendeeDomains: domains,
        summaryExcerpt: String(meeting.summary || '').slice(0, 1500),
        folders,
      });
      if (r && r.client) {
        const min = config.model?.minConfidence ?? 0.8;
        const where = r.newMatterName ? `${r.client} \\ ${r.newMatterName} (new matter folder)` : describe(r);
        if (r.confidence >= min) {
          return { client: r.client, matter: r.matter ?? null, newMatterName: r.newMatterName, rule: 'd', confidence: r.confidence, reason: `Model classifier (${classifier.name})` };
        }
        suggestion = `model suggests ${where} at confidence ${r.confidence.toFixed(2)} (below ${min})`;
      }
    } catch (e) {
      notes.push(`Model classifier failed: ${e.message}`);
    }
  }

  const reason = notes.length ? notes.join('; ') : (domains.length ? 'No rule matched (attendee domains not yet learned)' : 'No rule matched');
  return { client: null, matter: null, rule: 'e', confidence: 0, reason, suggestion };
}
