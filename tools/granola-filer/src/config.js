// Configuration and on-disk locations.
//
// Everything that is private to Raj's machine (tokens, state, the dry-run plan,
// config.json itself) lives under %LOCALAPPDATA%\granola-filer\ -- never in the
// repo and never in OneDrive.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function appDir() {
  const base = process.env.GRANOLA_FILER_HOME
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'granola-filer');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

export const files = {
  config: () => path.join(appDir(), 'config.json'),
  secrets: () => path.join(appDir(), 'secrets.dat'),
  state: () => path.join(appDir(), 'state.json'),
  plan: () => path.join(appDir(), 'dry-run-plan.txt'),
  log: () => path.join(appDir(), 'granola-filer.log'),
  lock: () => path.join(appDir(), 'run.lock'),
};

const CLIENT_ROOT = 'C:\\Users\\rajma\\OneDrive\\Documents\\_XEQtor\\Client';

export const DEFAULT_CONFIG = {
  // Folder with one sub-folder per client, each with matter sub-folders.
  clientRoot: CLIENT_ROOT,
  // Where meetings go when no rule is confident. Created if missing.
  inbox: path.join(CLIENT_ROOT, '_Meetings to file'),
  // Name of the sub-folder (inside a matter or client folder) that receives meeting notes.
  meetingsFolderName: 'Meetings',
  // Scheduled-task interval in minutes (used by install-schedule).
  intervalMinutes: 15,
  // How far back to look for meetings.
  lookbackDays: 30,
  // Only write a meeting once it ended at least this many minutes ago (and has a summary).
  readyAfterMinutes: 20,
  // Raj's own domains -- never used to learn client affinity.
  ownDomains: ['xeqtor.com'],
  // Webmail / generic domains -- never used to learn client affinity.
  genericDomains: [
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com',
    'live.co.uk', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'yahoo.co.uk',
    'aol.com', 'proton.me', 'protonmail.com',
  ],
  // Folder names that are never treated as matters.
  ignoreFolderNames: ['Meetings'],
  // Loopback port for the OAuth redirect (http://127.0.0.1:<port>/callback).
  oauthPort: 47823,
  // Scopes added to Granola's own "mcp" scope. offline_access = keep working without re-approval.
  oauthExtraScopes: ['offline_access'],
  // Granola folder name -> "Client" or "Client\\Matter" on disk, for Granola folders whose
  // names differ from the disk folders (rule a).
  folderMap: {},
  // Extra ways a client may be named in meeting titles, e.g. { "Some Client Ltd": ["SCL"] }.
  clientAliases: {},
  // Extra matter/client names too generic to trust in a title on their own.
  genericNames: [],
  // Granola MCP endpoint.
  mcpUrl: 'https://mcp.granola.ai/mcp',
  // Minimum gap between Granola API calls (ms). 1200 ms = max 50 calls/minute (limit is ~100).
  minCallGapMs: 1200,
  // Optional AI classifier. "none" = off. See README "Turning on the model".
  model: {
    provider: 'none',
    minConfidence: 0.8,
    ollama: {
      url: 'http://127.0.0.1:11434',
      model: 'qwen2.5:7b-instruct',
      timeoutMs: 120000,
    },
  },
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (base && typeof base[k] === 'object' && !Array.isArray(base[k])) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Load config.json (creating it with defaults on first use). */
export function loadConfig(configPath = files.config()) {
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    return structuredClone(DEFAULT_CONFIG);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  return deepMerge(DEFAULT_CONFIG, raw);
}

/** Append a line to the local log. Log lines must never contain meeting content. */
export function log(line) {
  const stamp = new Date().toISOString();
  try {
    fs.appendFileSync(files.log(), `${stamp} ${line}\n`, 'utf8');
  } catch { /* logging must never break a run */ }
}
