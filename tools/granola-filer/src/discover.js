// `discover`: print Granola's tool schemas and the *shape* of each response
// (key names, tag names and string lengths only -- never meeting content).

import { makeProvider } from './connect.js';
import { openNonInteractive } from './granola.js';
import { GranolaApi, buildListArgs } from './granola-api.js';
import { shape, textShape, parseMeetings, parseFolders } from './parse.js';

const show = (label, res) => {
  console.log(`\n--- ${label} ---`);
  if (res.json !== undefined) console.log(JSON.stringify(shape(res.json), null, 1));
  else console.log(JSON.stringify(textShape(res.text)));
};

export async function discover(config) {
  const g = await openNonInteractive({ config, provider: makeProvider(config) });
  try {
    const api = await GranolaApi.open(g);
    console.log('Tools and input parameters:');
    for (const t of Object.values(api.tools)) {
      const p = t.inputSchema?.properties || {};
      const req = new Set(t.inputSchema?.required || []);
      console.log(`  ${t.name}(${Object.entries(p).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${v.type || (v.enum ? 'enum' : '?')}`).join(', ')})`);
    }
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 86400000);
    const f = await g.call('list_meeting_folders', {});
    show('list_meeting_folders', f);
    console.log(`parsed folders: ${parseFolders(f).length}`);
    const args = buildListArgs(api.tools.list_meetings, { from, to });
    console.log(`\nlist_meetings args used: ${JSON.stringify(Object.keys(args))}`);
    const l = await g.call('list_meetings', args);
    show('list_meetings (last 7 days)', l);
    const ms = parseMeetings(l);
    console.log(`parsed meetings: ${ms.length}; with id ${ms.filter((m) => m.id).length}, with start ${ms.filter((m) => m.start).length}, with attendees ${ms.filter((m) => m.attendees.length).length}`);
    if (ms[0]) {
      const d = await api.getMeetings([ms[0].id]);
      const one = d.get(ms[0].id);
      show('get_meetings', api.lastRaw);
      console.log(`\nget_meetings parsed: ${one ? 'yes' : 'NO'}; fields present: ${one ? Object.entries(one).filter(([, v]) => v && (!Array.isArray(v) || v.length)).map(([k]) => k).join(', ') : '-'}`);
      const tr = await api.transcript(ms[0].id);
      show('get_meeting_transcript', api.lastRaw);
      console.log(`transcript: ${tr.length} chars, ${tr.split('\n').length} lines`);
    }
  } finally {
    await g.close();
  }
}
