// Windows DPAPI (current-user scope) via a tiny PowerShell helper.
// The encrypted blob can only be decrypted by Raj's Windows account on this machine.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const ENTROPY = 'granola-filer.v1';

function ps(script, input) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

const PROTECT = `Add-Type -AssemblyName System.Security;
$in = [Console]::In.ReadToEnd().Trim();
$bytes = [Convert]::FromBase64String($in);
$ent = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}');
$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $ent, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
[Console]::Out.Write([Convert]::ToBase64String($enc))`;

const UNPROTECT = `Add-Type -AssemblyName System.Security;
$in = [Console]::In.ReadToEnd().Trim();
$bytes = [Convert]::FromBase64String($in);
$ent = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}');
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $ent, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
[Console]::Out.Write([Convert]::ToBase64String($dec))`;

export function protect(plaintext) {
  return ps(PROTECT, Buffer.from(plaintext, 'utf8').toString('base64'));
}

export function unprotect(blobBase64) {
  return Buffer.from(ps(UNPROTECT, blobBase64), 'base64').toString('utf8');
}

/** A small JSON store encrypted at rest with DPAPI. Cached in memory after first read. */
export class SecretStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.cache = undefined;
  }

  get() {
    if (this.cache === undefined) {
      this.cache = fs.existsSync(this.filePath)
        ? JSON.parse(unprotect(fs.readFileSync(this.filePath, 'utf8')))
        : {};
    }
    return this.cache;
  }

  update(patch) {
    this.cache = { ...this.get(), ...patch };
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, protect(JSON.stringify(this.cache)), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  clear(keys) {
    const next = { ...this.get() };
    for (const k of keys) delete next[k];
    this.cache = {};
    this.update(next);
  }
}
