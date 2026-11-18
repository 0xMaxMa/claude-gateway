import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestSessionInfo } from '../../../mcp/tools/telegram/session-browser';
import { LiveTaskBrowser } from '../../../mcp/tools/telegram/task-browser';
import {
  CallbackHttpError, callbackFailureReply, classifyCallbackFailure, formatCallbackFailure,
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

test('a callback that does not answer in time is reported as busy, with timeout logged', async () => {
  const base = await serve(() => { /* never responds */ });
  const failure = classifyCallbackFailure(await openSession(base, 200));
  expect(failure).toMatchObject({ kind: 'busy', name: 'TimeoutError', timeout: true });
  expect(formatCallbackFailure('session', failure)).toMatch(/^telegram channel: \/session failed \(kind=busy name=TimeoutError timeout=true /);
  expect(callbackFailureReply(failure.kind, 'session info', 'session'))
    .toBe('The agent is busy and did not answer in time. Please try /session again in a moment.');
});

test('a 503 from admission failure is reported as unavailable with its HTTP status', async () => {
  const base = await serve((_req, res) => {
    res.writeHead(503); res.end(JSON.stringify({ accepted: false, code: 'CHANNEL_ADMISSION_FAILED', retryable: true }));
  });
  const error = await openSession(base);
  expect(error).toBeInstanceOf(CallbackHttpError);
  const failure = classifyCallbackFailure(error);
  expect(failure).toMatchObject({ kind: 'unavailable', status: 503, timeout: false });
  expect(formatCallbackFailure('session', failure)).toContain('status=503');
  expect(callbackFailureReply(failure.kind, 'session info', 'session'))
    .toBe('The agent is restarting or unavailable. Please try /session again shortly.');
});

test('a callback port with nothing listening (agent restarting) is unavailable, and the URL is not logged', async () => {
  const base = await closedPortBase();
  const failure = classifyCallbackFailure(await openSession(base));
  expect(failure).toMatchObject({ kind: 'unavailable', code: 'ECONNREFUSED' });
  const line = formatCallbackFailure('session', failure);
  expect(line).not.toContain(base);
  expect(line).not.toContain(new URL(base).port);
});

test('other non-OK statuses and malformed bodies stay generic but keep their cause', async () => {
  const base500 = await serve((_req, res) => { res.writeHead(500); res.end('{}'); });
  const f500 = classifyCallbackFailure(await openSession(base500));
  expect(f500).toMatchObject({ kind: 'failed', status: 500 });
  expect(callbackFailureReply(f500.kind, 'session info', 'session')).toBe('Could not load session info. Please try /session again.');

  const malformed = await serve((_req, res) => { res.writeHead(200); res.end(JSON.stringify({ success: false, text: 'Failed to get session info.' })); });
  const fBody = classifyCallbackFailure(await openSession(malformed));
  expect(fBody).toMatchObject({ kind: 'failed', message: 'Session info unavailable' });
});

test('unconfigured callback, unauthorized open and Telegram errors are classified without leaking URLs', async () => {
  expect(classifyCallbackFailure(await openSession(undefined)).kind).toBe('unavailable');
  expect(classifyCallbackFailure(new Error('TASK_BROWSER_UNAUTHORIZED'))).toMatchObject({ kind: 'failed', message: 'TASK_BROWSER_UNAUTHORIZED' });
  const telegram = Object.assign(new Error("Call to 'sendMessage' failed!"), { name: 'GrammyError', error_code: 400, description: 'Bad Request: see https://api.telegram.org/botSECRET/sendMessage' });
  const failure = classifyCallbackFailure(telegram);
  // A Telegram 5xx/429 is not the agent being busy or restarting.
  expect(failure).toMatchObject({ kind: 'failed', status: 400 });
  expect(formatCallbackFailure('session', failure)).not.toContain('SECRET');
  expect(classifyCallbackFailure(Object.assign(new Error('x'), { error_code: 429 })).kind).toBe('failed');
});
