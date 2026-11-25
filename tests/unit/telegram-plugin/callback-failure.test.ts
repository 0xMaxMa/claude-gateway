import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestSessionInfo } from '../../../mcp/tools/telegram/session-browser';
import { LiveTaskBrowser } from '../../../mcp/tools/telegram/task-browser';
import {
  CallbackHttpError, callbackFailureReply, callbackRejection, classifyCallbackFailure, formatCallbackFailure, readCallbackResult,
} from '../../../mcp/tools/telegram/callback-failure';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
const servers: http.Server[] = [];
async function serve(handler: Handler): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function closedPortBase(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
});

// Opens /session through the same LiveTaskBrowser path the receiver uses and
// returns the error it rejects with.
async function openSession(base: string | undefined, timeoutMs = 2000): Promise<unknown> {
  const browser = new LiveTaskBrowser({
    read: chat => requestSessionInfo(base, chat, timeoutMs),
    render: r => ({ text: (r as unknown as { text: string }).text, reply_markup: { inline_keyboard: [] } }),
    send: async () => 1, edit: async () => {}, remove: async () => {}, close: async () => {},
    allowed: () => true, persist: () => {},
  });
  return browser.open('42', '42').then(() => undefined, (error: unknown) => error);
}

test('a callback that does not answer in time is reported as a timeout, not as a busy agent', async () => {
  const base = await serve(() => { /* never responds */ });
  const failure = classifyCallbackFailure(await openSession(base, 200));
  expect(failure).toMatchObject({ kind: 'timeout', name: 'TimeoutError', timeout: true });
  expect(formatCallbackFailure('session', failure)).toMatch(/^telegram channel: \/session failed \(kind=timeout name=TimeoutError timeout=true /);
  expect(callbackFailureReply(failure.kind, 'session info', 'session'))
    .toBe('The agent did not answer in time. Please try /session again in a moment.');
});

test('a non-OK status is kept for the log and stays a generic failure', async () => {
  // /command answers 500 from its own catch blocks; it never sends 429/503.
  const base = await serve((_req, res) => { res.writeHead(500); res.end(JSON.stringify({ success: false, error: 'boom' })); });
  const error = await openSession(base);
  expect(error).toBeInstanceOf(CallbackHttpError);
  const failure = classifyCallbackFailure(error);
  expect(failure).toMatchObject({ kind: 'failed', status: 500, timeout: false });
  expect(formatCallbackFailure('session', failure)).toContain('status=500');
  expect(failure.message).toBe('callback HTTP 500: boom');
  expect(callbackFailureReply(failure.kind, 'session info', 'session')).toBe('Could not load session info. Please try /session again.');
});

test('a callback port with nothing listening (agent restarting) is unavailable, and the URL is not logged', async () => {
  const base = await closedPortBase();
  const failure = classifyCallbackFailure(await openSession(base));
  expect(failure).toMatchObject({ kind: 'unavailable', code: 'ECONNREFUSED' });
  const line = formatCallbackFailure('session', failure);
  expect(line).not.toContain(base);
  expect(line).not.toContain(new URL(base).port);
});

test('a success:false reply keeps the agent reason in the logged message', async () => {
  const base = await serve((_req, res) => { res.writeHead(200); res.end(JSON.stringify({ success: false, text: 'Failed to get session info.' })); });
  const failure = classifyCallbackFailure(await openSession(base));
  expect(failure).toMatchObject({ kind: 'failed', message: 'Session info unavailable: Failed to get session info.' });
  expect(callbackRejection(null).message).toBe('unavailable');
  expect(callbackRejection({ success: false, error: 'Task controls require orchestration mode.' }).message)
    .toBe('unavailable: Task controls require orchestration mode.');
});

test('Bun refused-connection errors (the receiver runtime) mean the agent is unavailable', () => {
  // Shape observed from Bun 1.3 fetch against a closed port.
  const bun = Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' });
  expect(classifyCallbackFailure(bun)).toMatchObject({ kind: 'unavailable', code: 'ConnectionRefused' });
});

test('a failed button press does not hide the next background refresh failure', async () => {
  let now = 0, fail = false;
  const report = jest.fn();
  const browser = new LiveTaskBrowser({
    read: async () => { if (fail) throw new Error('refresh failed'); return { sessionId: 's', page: 0 }; },
    render: () => ({ text: 'x', reply_markup: {} }),
    send: async () => 1, edit: async () => {}, remove: async () => {}, close: async () => {},
    allowed: () => true, persist: () => {}, report, now: () => now,
  });
  await browser.open('42', '42');
  fail = true;
  await expect(browser.navigate('42', '42', 1, { page: 1 })).rejects.toThrow('refresh failed');
  now += 20000; await browser.tick();
  expect(report).toHaveBeenCalledTimes(1);
});

test('a background refresh failure is reported once per failure streak', async () => {
  let now = 0, fail = false;
  const report = jest.fn();
  const browser = new LiveTaskBrowser({
    read: async () => { if (fail) throw new Error('refresh failed'); return { sessionId: 's', page: 0 }; },
    render: () => ({ text: 'x', reply_markup: {} }),
    send: async () => 1, edit: async () => {}, remove: async () => {}, close: async () => {},
    allowed: () => true, persist: () => {}, report, now: () => now,
  });
  await browser.open('42', '42');
  fail = true;
  await browser.tick(); now += 20000; await browser.tick();
  expect(report).toHaveBeenCalledTimes(1);
  fail = false; now += 20000; await browser.tick();
  fail = true; now += 20000; await browser.tick();
  expect(report).toHaveBeenCalledTimes(2);
});

test('unconfigured callback, unauthorized open and Telegram errors are classified without leaking URLs', async () => {
  // A missing callback URL is a configuration error, not a restart.
  expect(classifyCallbackFailure(await openSession(undefined))).toMatchObject({ kind: 'failed', message: 'not_configured' });
  expect(classifyCallbackFailure(new Error('TASK_BROWSER_UNAUTHORIZED'))).toMatchObject({ kind: 'failed', message: 'TASK_BROWSER_UNAUTHORIZED' });
  const telegram = Object.assign(new Error("Call to 'sendMessage' failed!"), { name: 'GrammyError', error_code: 400, description: 'Bad Request: see https://api.telegram.org/botSECRET/sendMessage' });
  const failure = classifyCallbackFailure(telegram);
  expect(failure).toMatchObject({ kind: 'failed', telegramCode: 400 });
  expect(failure.status).toBeUndefined();
  expect(formatCallbackFailure('session', failure)).toContain('telegram_code=400');
  expect(formatCallbackFailure('session', failure)).not.toContain('SECRET');
  // #686: the user is told Telegram rejected the reply, not a bare "Failed to get sessions."
  expect(callbackFailureReply(failure.kind, 'sessions', 'sessions', failure.telegramCode))
    .toBe('Telegram rejected the /sessions reply (error 400). Please try /sessions again; if it keeps failing, report it.');
  expect(callbackFailureReply('failed', 'sessions', 'sessions', 429)).toBe('Telegram is rate-limiting this chat. Please wait a minute, then try /sessions again.');
  expect(classifyCallbackFailure(Object.assign(new Error('x'), { error_code: 429 })).kind).toBe('failed');
  // A Telegram network failure keeps its code for the log but is not an agent restart.
  const telegramNetwork = Object.assign(new Error('Network request failed'), { name: 'HttpError', error: { code: 'ECONNREFUSED' } });
  expect(classifyCallbackFailure(telegramNetwork)).toMatchObject({ kind: 'failed', code: 'ECONNREFUSED' });
});

test('readCallbackResult keeps the HTTP status, the agent reason and its error code', async () => {
  const base = await serve((req, res) => {
    const [status, body] = req.url === '/500' ? [500, '{"success":false,"error":"voice_settings_unavailable"}']
      : req.url === '/html' ? [502, '<html>bad gateway</html>']
      : req.url === '/expired' ? [200, '{"success":false,"error":"Selection unavailable.","code":"STOP_MENU_EXPIRED"}']
      : [200, '{"success":true,"text":"ok"}'];
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body);
  });
  const read = (path: string) => fetch(base + path).then(r => readCallbackResult<{ success?: boolean; text?: string }>(r)).catch((e: unknown) => e);
  expect(await read('/ok')).toEqual({ success: true, text: 'ok' });
  const http500 = classifyCallbackFailure(await read('/500'));
  expect(http500).toMatchObject({ kind: 'failed', status: 500 });
  expect(http500.message).toContain('voice_settings_unavailable');
  expect(classifyCallbackFailure(await read('/html'))).toMatchObject({ kind: 'failed', status: 502 });
  const expired = await read('/expired') as { code?: string; message: string };
  expect(expired.code).toBe('STOP_MENU_EXPIRED');
  expect(expired.message).toBe('unavailable: Selection unavailable.');
  expect(classifyCallbackFailure(expired)).toMatchObject({ kind: 'failed', code: 'STOP_MENU_EXPIRED' });
});
