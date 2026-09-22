import express from 'express';
import { createServer } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createApiRouter } from '../../src/api/router';
import { HistoryDB } from '../../src/history/db';
import { AgentRunner } from '../../src/agent/runner';
import { AgentConfig } from '../../src/types';

test('HTTP committed-message stream replays, delivers live commits, reauthorizes and cleans up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'input-stream-'));
  const history = HistoryDB.forAgent(root, 'a');
  const sid = '11111111-1111-4111-8111-111111111111';
  const message = { chatId: 'api-chat', sessionId: sid, source: 'api' as const, role: 'user' as const, content: 'hello', ts: 1 };
  const first = history.insertMessageOnce('input:one', message);
  let denied = false;
  const authorize = jest.fn(async () => { if (denied) throw Error('ACCESS_DENIED'); });
  const runner = { authorizeVoiceSession: authorize, getHistoryDb: () => history } as unknown as AgentRunner;
  const app = express();
  app.use(createApiRouter(new Map([['a', runner]]), new Map([['a', {id:'a'} as AgentConfig]]), [{ key:'fixture', agents:['a'] }]));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/v1/agents/a/sessions/${sid}/messages/stream`;
  const controller = new AbortController();
  try {
    expect((await fetch(`${base}?after_id=-1`, {headers:{Authorization:'Bearer fixture'}})).status).toBe(400);
    expect((await fetch(base)).status).toBe(401);
    const response = await fetch(`${base}?after_id=0`, {headers:{Authorization:'Bearer fixture'}, signal:controller.signal});
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await read()).toContain(`"id":${first}`);
    history.insertMessageOnce('input:other', {...message, sessionId:'other'});
    const second = history.insertMessageOnce('input:two', {...message, ts:0});
    const live = await read();
    expect(live).toContain(`"id":${second}`);
    expect(live).not.toContain('input:other');
    expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(3);
    denied = true;
    history.insertMessageOnce('input:forbidden', message);
    expect((await reader.read()).done).toBe(true);
    expect((history as any).messageListeners.size).toBe(0);
    expect((await fetch(base, {headers:{Authorization:'Bearer fixture'}})).status).toBe(403);
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    (history as any).db.close(); HistoryDB.evict(root,'a'); rmSync(root,{recursive:true,force:true});
  }
});
