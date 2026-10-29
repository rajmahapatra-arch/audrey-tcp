import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMeetings, parseAttendees, parseFolders, parseTranscript, parseAccountInfo, nextCursor } from '../src/parse.js';
import { buildListArgs, idArgs } from '../src/granola-api.js';
import { assertAllowed } from '../src/granola.js';
import { readiness, granolaFolderPaths } from '../src/filer.js';
import { toastText } from '../src/toast.js';

// Synthetic response in the layout Granola's MCP server uses (tagged text). Fictitious content.
const LIST = `<meetings_data connected_user_email="me@xeqtor.com" workspace_name="WS" from="Oct 1, 2026" to="Oct 29, 2026" count="2">
<meeting id="11111111-aaaa-4bbb-8ccc-000000000001" title="Supply &amp; terms" date="Oct 5, 2026 9:30 AM" meeting_at="2026-10-05T09:30:00.000+01:00" url="https://notes.granola.ai/d/11111111">
    <known_participants>
    Me Person (note creator) from Xeqtor (me@xeqtor.com), Pat Doe from Northwind (pat@nw.example), Sam Roe
    </known_participants>
    <folders>
      <folder id="f1" title="Northwind deals" visibility="private" />
    </folders>
  </meeting>
<meeting id="11111111-aaaa-4bbb-8ccc-000000000002" title="Solo" date="Oct 6, 2026" meeting_at="2026-10-06T14:00:00.000+01:00">
    <known_participants>
    Me Person (note creator) from Xeqtor (me@xeqtor.com)
    </known_participants>
    <folders />
  </meeting>
</meetings_data>
<pagination has_more="true" next_cursor="abc/def==" total_count="3" remaining_count="1" />`;

test('parseMeetings reads Granola tagged text', () => {
  const ms = parseMeetings({ text: LIST });
  assert.equal(ms.length, 2);
  const [a, b] = ms;
  assert.equal(a.id, '11111111-aaaa-4bbb-8ccc-000000000001');
  assert.equal(a.title, 'Supply & terms');
  assert.equal(a.start.toISOString(), '2026-10-05T08:30:00.000Z');
  assert.deepEqual(a.granolaFolders, ['Northwind deals']);
  assert.deepEqual(a.attendees, [
    { name: 'Me Person', email: 'me@xeqtor.com' },
    { name: 'Pat Doe', email: 'pat@nw.example' },
    { name: 'Sam Roe', email: null },
  ]);
  assert.equal(a.link, 'https://notes.granola.ai/d/11111111');
  assert.deepEqual(b.granolaFolders, []);
  assert.equal(nextCursor({ text: LIST }), 'abc/def==');
});

test('parseMeetings reads get_meetings detail (summary, notes, updated_at)', () => {
  const t = `<meetings_data count="1"><meeting id="m1" title="T" meeting_at="2026-10-05T09:30:00Z" updated_at="2026-10-05T10:40:00Z">
  <known_participants>A (a@x.example)</known_participants>
  <folders />
  <private_notes status="present">my note</private_notes>
  <summary>
# Heading
- point
  </summary>
</meeting></meetings_data>`;
  const [m] = parseMeetings({ text: t });
  assert.equal(m.summary, '# Heading\n- point');
  assert.equal(m.notes, 'my note');
  assert.equal(m.updatedAt.toISOString(), '2026-10-05T10:40:00.000Z');
  const [e] = parseMeetings({ text: t.replace('<private_notes status="present">my note</private_notes>', '<private_notes status="empty" />') });
  assert.equal(e.notes, '');
});

test('parseMeetings also accepts JSON shapes', () => {
  const ms = parseMeetings({ json: { meetings: [{ id: 7, title: 'J', start_time: '2026-10-01T10:00:00Z', attendees: [{ name: 'N', email: 'N@X.EXAMPLE' }], folders: [{ name: 'F' }] }] } });
  assert.equal(ms[0].id, '7');
  assert.equal(ms[0].attendees[0].email, 'n@x.example');
  assert.deepEqual(ms[0].granolaFolders, ['F']);
});

test('parseAttendees handles angle brackets and bare emails', () => {
  assert.deepEqual(parseAttendees('Jo <jo@a.example>; b@b.example'), [{ name: 'Jo', email: 'jo@a.example' }, { name: null, email: 'b@b.example' }]);
});

test('parseFolders, folder paths, transcript, account info', () => {
  const f = parseFolders({ json: { count: 2, folders: [{ id: 'p', title: 'Parent', parent_folder_id: null }, { id: 'c', title: 'Child', parent_folder_id: 'p' }] } });
  assert.deepEqual(f, [{ id: 'p', name: 'Parent', parentId: null }, { id: 'c', name: 'Child', parentId: 'p' }]);
  assert.equal(granolaFolderPaths(f).get('Child'), 'Parent / Child');
  assert.equal(parseTranscript({ json: { id: 'x', transcript: 'Me: hi\nThem: hello', truncated: false } }), 'Me: hi\nThem: hello');
  assert.equal(parseTranscript({ json: { transcript: [{ speaker: 'Me', text: 'hi' }] } }), 'Me: hi');
  assert.deepEqual(parseAccountInfo({ json: { email: 'me@xeqtor.com', workspace: { id: 'w1', name: 'WS' } } }), { email: 'me@xeqtor.com', workspace: 'WS', workspaceId: 'w1' });
});

test('buildListArgs uses a custom date range from the schema', () => {
  const schema = { inputSchema: { properties: {
    custom_start: { type: 'string' }, limit: { type: 'integer', maximum: 9e15 }, cursor: { type: 'string' },
    time_range: { type: 'string', enum: ['last_7_days', 'last_30_days', 'custom'] },
    from_date: { type: 'string' }, to_date: { type: 'string' }, folder_id: { type: 'string' },
  } } };
  const args = buildListArgs(schema, { from: new Date(2026, 8, 29), to: new Date(2026, 9, 29), cursor: 'c1' });
  assert.deepEqual(args, { time_range: 'custom', from_date: '2026-09-29', to_date: '2026-10-29', limit: 100, cursor: 'c1' });
  const ids = idArgs({ inputSchema: { properties: { meeting_ids: { type: 'array', maxItems: 10 }, note_ids: { type: 'array' } } } });
  assert.equal(ids.max, 10);
  assert.deepEqual(ids.make(['a', 'b']), { meeting_ids: ['a', 'b'] });
});

test('only read-only Granola tools can be called', () => {
  for (const t of ['switch_workspace', 'sign_out', 'query_granola_meetings', 'create_folder', 'add_note_to_folder', 'update_private_notes', 'generate_summary']) {
    assert.throws(() => assertAllowed(t), /Refusing/);
  }
  for (const t of ['get_account_info', 'list_meetings', 'get_meetings', 'get_meeting_transcript', 'list_meeting_folders']) assertAllowed(t);
});

test('readiness needs a summary and 20 quiet minutes after the meeting', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  assert.equal(readiness({ summary: '', start: new Date('2026-10-05T09:00:00Z') }, now, 20).ready, false);
  assert.equal(readiness({ summary: 's', start: new Date('2026-10-05T09:00:00Z'), updatedAt: new Date('2026-10-05T11:50:00Z') }, now, 20).ready, false);
  assert.equal(readiness({ summary: 's', start: new Date('2026-10-05T09:00:00Z'), updatedAt: new Date('2026-10-05T11:30:00Z') }, now, 20).ready, true);
  // no updated_at: assume up to 1 h
  assert.equal(readiness({ summary: 's', start: new Date('2026-10-05T10:50:00Z') }, now, 20).ready, false);
  assert.equal(readiness({ summary: 's', start: new Date('2026-10-05T10:30:00Z') }, now, 20).ready, true);
});

test('toast text', () => {
  assert.equal(toastText({ filed: 3, inbox: 1 }), '3 meetings filed, 1 waiting to be filed');
  assert.equal(toastText({ filed: 1, inbox: 0 }), '1 meeting filed');
});
