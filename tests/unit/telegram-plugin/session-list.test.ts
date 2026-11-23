import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { classifyCallbackFailure } from '../../../mcp/tools/telegram/callback-failure';
import { SESSIONS_PER_PAGE, listSessionsRequest, sessionListMenu, type SessionListEntry } from '../../../mcp/tools/telegram/session-list';

// #686: Telegram rejects an inline keyboard over 100 buttons with
// 400 "reply markup is too long", so /sessions failed once a chat had ~50 sessions.
const NOW = 1_800_000_000_000;
const sessions = (n: number): SessionListEntry[] => Array.from({ length: n }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  name: `Session ${i + 1}`,
  messageCount: i,
  lastActive: NOW - i * 60_000,
}));
const buttons = (menu: ReturnType<typeof sessionListMenu>) => menu.reply_markup.inline_keyboard.flat() as Array<{ text: string; callback_data: string }>;
const data = (menu: ReturnType<typeof sessionListMenu>) => buttons(menu).map(b => b.callback_data);

test.each([0, 1, 8, 9, 68, 200])('every page of %i sessions fits Telegram limits', count => {
  const list = sessions(count);
  const first = sessionListMenu(list, list[0]?.id ?? '', 0, NOW);
  expect(buttons(first).length).toBeLessThanOrEqual(100);
  expect(first.pages).toBe(Math.max(1, Math.ceil(count / SESSIONS_PER_PAGE)));
  const seen = new Set<string>();
  for (let page = 0; page < first.pages; page++) {
    const menu = sessionListMenu(list, list[0]?.id ?? '', page, NOW);
    expect(buttons(menu).length).toBeLessThanOrEqual(100);
    expect(menu.text.length).toBeLessThanOrEqual(4096);
    for (const d of data(menu)) expect(Buffer.byteLength(d, 'utf8')).toBeLessThanOrEqual(64);
    for (const d of data(menu)) if (d.startsWith('session_switch:')) seen.add(d.slice('session_switch:'.length));
  }
  // Switch is reachable for every session from some page.
  expect(seen).toEqual(new Set(list.map(s => s.id)));
});

test('68 sessions open on page 1, newest first, with Next only', () => {
  const list = sessions(68).reverse();
  const menu = sessionListMenu(list, list[67].id, 0, NOW);
  expect(menu.pages).toBe(9);
  expect(menu.text.split('\n')[0]).toBe('\u{1F5C2} Sessions (68) · Page 1/9');
  expect(data(menu)).toEqual([
    ...sessions(8).flatMap(s => [`session_switch:${s.id}`, `session_delete:${s.id}`]),
    'session_page:1', 'session_new', 'session_back',
  ]);
  expect(buttons(menu)[0].text).toBe('\u{1F7E2} Session 1');
});

test('a middle page has Prev and Next; the last page has Prev only', () => {
  const list = sessions(20);
  expect(data(sessionListMenu(list, '', 1, NOW))).toEqual(expect.arrayContaining(['session_page:0', 'session_page:2']));
  const last = data(sessionListMenu(list, '', 2, NOW));
  expect(last).toContain('session_page:1');
  expect(last).not.toContain('session_page:3');
  expect(last.filter(d => d.startsWith('session_switch:'))).toHaveLength(4);
});

test('a stale page after deletes is clamped to the last real page', () => {
  const menu = sessionListMenu(sessions(9), '', 5, NOW);
  expect(menu.page).toBe(1);
  expect(menu.text).toContain('Page 2/2');
});

test('a single session has no delete button and no page controls', () => {
  const menu = sessionListMenu(sessions(1), '', 0, NOW);
  expect(data(menu)).toEqual([`session_switch:${sessions(1)[0].id}`, 'session_new', 'session_back']);
  expect(menu.text).not.toContain('Page');
});

test('an id too long for callback_data is not sent as a button, and long names are clipped', () => {
  const list = [{ id: 'x'.repeat(60), name: 'n'.repeat(300), messageCount: 1, lastActive: NOW }, ...sessions(1)];
  const menu = sessionListMenu(list, '', 0, NOW);
  for (const d of data(menu)) expect(Buffer.byteLength(d, 'utf8')).toBeLessThanOrEqual(64);
  expect(data(menu)).not.toContain(`session_switch:${'x'.repeat(60)}`);
  expect(menu.text).toContain('Sessions (2)');
  expect(menu.text).not.toContain('n'.repeat(61));
});

const servers: http.Server[] = [];
async function agent(status: number, body: string, seen?: unknown[]): Promise<string> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { seen?.push(JSON.parse(raw)); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body); });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
});

test('/sessions against a stubbed agent with 68 sessions renders a page Telegram accepts', async () => {
  const seen: unknown[] = [];
  const list = sessions(68);
  const base = await agent(200, JSON.stringify({ sessions: [...list, { id: 1 }, null, { id: 'nan', name: 'x', messageCount: 1, lastActive: null }], activeSessionId: list[3].id }), seen);
  const { sessions: got, activeId } = await listSessionsRequest(base, '42');
  expect(seen).toEqual([{ command: 'list_sessions', chat_id: '42' }]);
  expect(got).toHaveLength(68); // malformed rows are dropped
  const menu = sessionListMenu(got, activeId, 0, NOW);
  expect(buttons(menu).length).toBe(8 * 2 + 3);
  expect(buttons(menu)[6].text).toBe('\u{1F7E2} Session 4');
});

test('a failed list keeps the agent reason and HTTP status for the log', async () => {
  await expect(listSessionsRequest(await agent(200, '{"success":false,"error":"Failed to list sessions"}'), '42'))
    .rejects.toThrow('unavailable: Failed to list sessions');
  const failure = classifyCallbackFailure(await listSessionsRequest(await agent(500, '{"error":"boom"}'), '42').catch(e => e));
  expect(failure).toMatchObject({ kind: 'failed', status: 500, message: 'callback HTTP 500: boom' });
  await expect(listSessionsRequest(undefined, '42')).rejects.toThrow('not_configured');
});

test('labels never split an emoji or come out empty', () => {
  const list = [
    { id: 'a', name: 'x'.repeat(39) + '\u{1F600}tail', messageCount: 1, lastActive: NOW },
    { id: 'b', name: '   ', messageCount: 1, lastActive: NOW - 1 },
  ];
  const menu = sessionListMenu(list, 'a', 0, NOW);
  const labels = buttons(menu).filter(b => b.callback_data.startsWith('session_switch:')).map(b => b.text);
  for (const text of [...labels, menu.text]) expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
  expect(labels[1]).toBe('Untitled');
});
