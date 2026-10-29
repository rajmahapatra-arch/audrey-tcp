// Shared fixtures. All names are fictitious.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';

export function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'granola-filer-test-'));
  const root = path.join(dir, 'Client');
  const tree = {
    'Northwind Traders': ['Supply Agreement', 'Employment', 'NDA'],
    'Contoso Robotics': ['Series A', 'Employment', 'Employment related', 'Brand'],
    Fabrikam: [],
  };
  for (const [c, ms] of Object.entries(tree)) {
    fs.mkdirSync(path.join(root, c), { recursive: true });
    for (const m of ms) fs.mkdirSync(path.join(root, c, m));
  }
  fs.mkdirSync(path.join(root, 'Fabrikam', 'Meetings')); // must not be treated as a matter
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    clientRoot: root,
    inbox: path.join(root, '_Meetings to file'),
  };
  return { dir, root, config, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
