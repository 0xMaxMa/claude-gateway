import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentRunner } from '../../../src/agent/runner';
import { createApiRouter } from '../../../src/api/router';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { SessionProcess } from '../../../src/session/process';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';

test('orchestration-enabled existing HTTP/SSE contract: follow-up while worker busy and 409 before input admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-http-')), agentDir = join(root, 'agents', 'a');
  const agent: AgentConfig = { id: 'a', description: '', workspace: join(agentDir, 'workspace'), env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  const runner = new AgentRunner(agent, gateway);
  const sessions = new SessionStore(join(root, 'agents')), history = HistoryDB.forDir(agentDir, 'a');
  let runtime: AgentOrchestrationRuntime, turn = 0, second!: SessionProcess, ready!: () => void;
  const secondReady = new Promise<void>(resolve => { ready = resolve; });
  const workers: Array<() => void> = [];
  runtime = await AgentOrchestrationRuntime.open(agent, gateway, agentDir, sessions, history, {
    createAgentSession: async () => {
      const agentSession = new EventEmitter() as SessionProcess;
      agentSession.start = async () => {}; agentSession.stop = async () => {};
      agentSession.sendMessage = () => {
        if (++turn === 1) {
          const decision = runtime.store.get("SELECT d.*,c.owner_principal_id FROM conversation_decisions d JOIN conversations c ON c.id=d.conversation_id WHERE d.state='running'")!;
          runtime.tasks.spawn({ conversationId: String(decision.conversation_id), principalId: String(decision.owner_principal_id), inputId: JSON.parse(String(decision.input_ids_json))[0],
            decisionId: String(decision.id), epoch: Number(decision.epoch), actionId: 'http-action', execute: true, writeMemory: false }, { title: 'Fix code', instructions: 'Fix fixture', targetProfile: 'default-worker' });
          agentSession.emit('output', JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Queued.' } } }));
          agentSession.emit('output', JSON.stringify({ type: 'result', result: 'Queued.' }));
        } else { second = agentSession; ready(); }
      };
      return agentSession;
    }, releaseAgentSession: async () => {},
  }, { start: async () => ({ accepted: Promise.resolve(), result: new Promise(resolve => workers.push(() => resolve({ type: 'completed', result: { summary: 'done', artifactIds: [] } }))), stop: async () => { for (const complete of workers) complete(); } }) });
  (runner as unknown as { orchestration: AgentOrchestrationRuntime }).orchestration = runtime;
  const app = express(); app.use(express.json());
  app.use('/api', createApiRouter(new Map([['a', runner]]), new Map([['a', agent]]), [{ id: 'owner', key: 'fixture', agents: ['a'], allow_tools: true }, { id: 'stranger', key: 'stranger', agents: ['a'] }]));
  try {
    const initial = await request(app).post('/api/v1/agents/a/messages').set('Authorization', 'Bearer fixture').send({ chat_id: 'chat', message: 'Fix code', stream: true,
      image_params: { model: 'fixture-image', size: '1024x1024', image_refs: ['https://example.invalid/ref.png'] } });
    expect(initial.status).toBe(200); expect(initial.headers['content-type']).toContain('text/event-stream'); expect(initial.text).toContain('data: [DONE]');
    const frames = initial.text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    expect(frames.some(frame => frame.type === 'text_delta')).toBe(true);
    const result = frames.find(frame => frame.type === 'result'); expect(result).toBeDefined();
    const sessionId = result.session_id;
    const activity = await request(app).get(`/api/v1/agents/a/sessions/${sessionId}/activity`).set('Authorization', 'Bearer fixture');
    expect(activity.status).toBe(200); expect(activity.body.tasks[0].title).toBe('Fix code');
    expect(activity.body.responses[0].text).toBe('Queued.');
    const forbidden = await request(app).get(`/api/v1/agents/a/sessions/${sessionId}/activity`).set('Authorization', 'Bearer stranger');
    expect(forbidden.status).toBe(403);
    expect((await request(app).get(`/api/v1/agents/a/sessions/${sessionId}/activity?after=-1`).set('Authorization', 'Bearer fixture')).status).toBe(400);

    const pending = request(app).post('/api/v1/agents/a/messages').set('Authorization', 'Bearer fixture').send({ chat_id: 'chat', session_id: sessionId, message: 'Status?' }).then(response => response);
    await secondReady;
    const inputs = runtime.store.all('SELECT ingress_json FROM conversation_inputs ORDER BY input_seq').map(row => JSON.parse(String(row.ingress_json)));
    expect(inputs[0].metadata.imageRefs).toEqual(['https://example.invalid/ref.png']);
    expect(inputs[1].metadata.promptContext).toContain('fixture-image');
    expect(inputs[1].metadata.promptContext).toContain('1024x1024');
    expect(inputs[1].metadata.imageRefs).toBeUndefined();
    const conflict = await request(app).post('/api/v1/agents/a/messages').set('Authorization', 'Bearer fixture').send({ chat_id: 'chat', session_id: sessionId, message: 'Duplicate active request', stream: true });
    expect(conflict.status).toBe(409); expect(conflict.headers['content-type']).toContain('application/json');
    expect(runtime.store.get('SELECT COUNT(*) n FROM conversation_inputs')!.n).toBe(2);
    expect(runtime.store.get("SELECT COUNT(*) n FROM tasks WHERE state='completed'")!.n).toBe(0);
    second.emit('output', JSON.stringify({ type: 'result', result: 'Still working.' }));
    const followup = await pending; expect(followup.status).toBe(200); expect(followup.body).toMatchObject({ session_id: sessionId, response: 'Still working.' });
  } finally {
    for (const complete of workers) complete(); await runtime.close();
    (history as unknown as { db: { close(): void } }).db.close(); HistoryDB.evict(join(root, 'agents'), 'a'); rmSync(root, { recursive: true, force: true });
  }
});
