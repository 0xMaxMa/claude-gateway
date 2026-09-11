import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { ShareFileModule } from '../../../mcp/tools/share-file/module';
import { TaskFiles } from '../../../src/orchestration/task-files';
import { TaskWorkspaces } from '../../../src/orchestration/tasks/workspace';
import { DeliveryOutbox, channelSender } from '../../../src/orchestration/delivery';
import { workerShares } from '../../../src/orchestration/worker-shares';
import { AgentConfig, GatewayConfig } from '../../../src/types';
import { receiveChannelMedia } from '../../../src/orchestration/channel-media';
import express from 'express';
import { createSharesPrivateRouter, createSharesPublicRouter } from '../../../src/api/share-router';
import { ShareStore } from '../../../src/share/share-store';
import { once } from 'events';
import { OrchestrationHistoryWriter } from '../../../src/orchestration/history';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import { computeSessionImageCatalog } from '../../../src/share/session-image-catalog';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3xkAAAAASUVORK5CYII=', 'base64');
const agent = '7e50cb45-0d71-4695-941c-197f7a86b8bc';
async function fixture(source: 'api' | 'telegram' = 'telegram') {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-media-')), workspace = join(root, 'agent', 'workspace'); mkdirSync(workspace, { recursive: true });
  const store = new OrchestrationStore(join(root, 'orchestration.db'), 'agent'), tasks = new TaskService(store), files = new TaskFiles(store, root);
  const send = jest.fn(async () => ({ state: 'delivered' as const, providerId: 'receipt' }));
  const delivery = new DeliveryOutbox(store, send), decisions = new DecisionService(store, (r,b,t) => delivery.enqueue(r,b,t));
  const scope = { agentId: 'agent', agentSessionId: agent, source, accountId: 'bot', chatId: '123', threadKey: '456', principalId: 'user' };
  const input = store.acceptInput({ scope, text: 'Make an image and remember a note' }), decision = decisions.begin(input.conversationId, 'user', [input.inputId]);
  const ctx = { ...input, ...decision, principalId: 'user', execute: true, writeMemory: true, actionId: 'spawn' };
  const task = tasks.spawn(ctx, { title: 'media', instructions: 'fixture', targetProfile: 'media-worker' }); decisions.finish(decision, 'Queued.'); await delivery.tick(); send.mockClear();
  const attempt = tasks.claim(task.taskId)!;
  const resources = new TaskWorkspaces(store, '/nonexistent-project', join(root, 'resources'), 'isolated-worktree');
  const resource = await resources.prepare(task.taskId); tasks.started(attempt.attemptId, attempt.generation);
  const path = join(resource.path, 'image.png'); writeFileSync(path, PNG);
  return { root, workspace, store, tasks, files, send, delivery, decisions, scope, task, attempt, path, ctx,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test.each(['telegram','discord'])('%s inbound provider reference is downloaded before durable admission and retries keep the same bytes', async source => {
  const f = await fixture();
  try {
    const request = jest.fn(async (url: string) => url.endsWith('/getFile')
      ? new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/file.txt', file_size: 3 } })) : new Response('DOC'));
    const agent = { id: 'agent', telegram: { botToken: 'fixture' } } as AgentConfig;
    const ref = source === 'telegram' ? 'file-id' : 'https://cdn.discordapp.com/attachments/1/file.txt';
    const first = await receiveChannelMedia(agent, f.root, source, 'chat', ref, request as typeof fetch);
    expect(await receiveChannelMedia(agent, f.root, source, 'chat', ref, request as typeof fetch)).toBe(first);
    expect(readFileSync(join(f.root, 'agent', first), 'utf8')).toBe('DOC');
    await expect(receiveChannelMedia(agent, f.root, 'discord', 'chat', 'https://example.invalid/secret', request as typeof fetch)).rejects.toThrow('INVALID_ATTACHMENT');
    const tooLarge = (async () => new Response('small body', { headers: { 'content-length': String(60 * 1024 * 1024) } })) as typeof fetch;
    await expect(receiveChannelMedia(agent, f.root, 'discord', 'chat', 'https://cdn.discordapp.com/attachments/1/file.txt', tooLarge)).rejects.toThrow('ATTACHMENT_TOO_LARGE');
  } finally { f.close(); }
});

test('no-Git media worker stages immutable files; next successful agent response delivers once to original thread', async () => {
  const f = await fixture();
  try {
    const { attempt: a } = f;
    const staged = f.files.stage(a.attemptId, a.generation, 'file', { path: f.path });
    expect(f.files.stage(a.attemptId, a.generation, 'file', { path: f.path })).toEqual(staged);
    expect(() => f.files.stage(a.attemptId, a.generation, 'file', { path: f.path, caption: 'changed' })).toThrow('IDEMPOTENCY_CONFLICT');
    expect(f.store.get('SELECT response_id FROM task_files')!.response_id).toBeNull();
    writeFileSync(f.path, 'changed after staging');
    f.tasks.finish(a.attemptId, a.generation, { type: 'completed', result: { summary: 'Done', artifactIds: [String(staged.artifactId)] } });
    const next = () => { const i = f.store.acceptInput({ scope: f.scope, text: 'Result?' }); return f.decisions.begin(i.conversationId, 'user', [i.inputId]); };
    f.decisions.finish(next(), 'Failed response', 'failed'); await f.delivery.tick(); f.send.mockClear();
    const response = f.decisions.finish(next(), 'Here is your image.');
    expect(f.store.get('SELECT response_id FROM task_files')!.response_id).toBe(response);
    const history = HistoryDB.forAgent(f.root, 'agent'), catalogStore = new ShareStore(join(f.root, 'catalog.db'));
    try {
      const writer = new OrchestrationHistoryWriter(f.store, new SessionStore(f.root), history);
      await writer.write(`response:${response}`); await writer.write(`response:${response}`);
      const catalog = computeSessionImageCatalog({ agentsBaseDir: f.root, store: catalogStore, agentId: 'agent', sessionId: agent });
      expect(catalog).toHaveLength(1); expect(catalog[0]).toMatchObject({ index: 1, origin: 'generated', available: true });
    } finally { catalogStore.close(); (history as unknown as { db: { close(): void } }).db.close(); HistoryDB.evict(f.root, 'agent'); }
    await f.delivery.tick(); await f.delivery.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    const call = (f.send.mock.calls as unknown as any[][])[1];
    expect(call[0]).toMatchObject({ chat_id: '123', thread_key: '456' });
    expect(call[3]).toMatchObject({ path: staged.path, kind: 'image' });
    expect(readFileSync(join(f.root, 'agent', String(staged.path)))).toEqual(PNG);
    expect(() => f.files.stage(a.attemptId, a.generation, 'late', { path: f.path })).toThrow('STALE_ATTEMPT');
  } finally { f.close(); }
});

test('scoped memory preserves prior content and deduplicates retry; API and identity writes are denied', async () => {
  const channel = await fixture(), api = await fixture('api');
  try {
    const a = channel.attempt; writeFileSync(join(channel.workspace, 'MEMORY.md'), 'Existing note.');
    const args = { path: 'MEMORY.md', note: 'Remember blue.' };
    channel.files.remember(a.attemptId, a.generation, 'remember', args); channel.files.remember(a.attemptId, a.generation, 'remember', args);
    const content = readFileSync(join(channel.workspace, 'MEMORY.md'), 'utf8');
    expect(content).toContain('Existing note.'); expect(content.match(/Remember blue\./g)).toHaveLength(1);
    expect(() => channel.files.remember(a.attemptId, a.generation, 'other', { ...args, path: 'IDENTITY.md' })).toThrow('MEMORY_PATH_DENIED');
    expect(() => api.files.remember(api.attempt.attemptId, api.attempt.generation, 'remember', args)).toThrow('MEMORY_WRITE_DENIED');
    const secret = join(channel.root, 'secret'); writeFileSync(secret, 'private');
    expect(() => channel.files.stage(a.attemptId, a.generation, 'secret', { path: secret })).toThrow('ARTIFACT_PATH_DENIED');
  } finally { channel.close(); api.close(); }
});

test('worker share bridge pins agent identity, rejects general routes, and keeps API credentials out of worker requests', async () => {
  const f = await fixture('api');
  try {
    const request = jest.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 201 }));
    const proxy = workerShares(f.files, { id: 'agent' } as AgentConfig, { gateway: { api: { keys: [{ key: 'gateway-only', agents: ['agent'] }] } } } as GatewayConfig, request as typeof fetch);
    const a = f.attempt;
    await proxy(a.attemptId, a.generation, { method: 'POST', pathname: '/api/v1/image-artifacts', body: { agent_id: 'other', session_id: 'other', files: [f.path] } });
    const init = (request.mock.calls as unknown as [string, RequestInit][])[0][1];
    expect(JSON.parse(String(init.body))).toMatchObject({ agent_id: 'agent', session_id: agent });
    await expect(proxy(a.attemptId, a.generation, { method: 'POST', pathname: '/api/v1/agents/other/messages', body: {} })).rejects.toThrow('SHARE_SCOPE_DENIED');
    expect(request).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('generated image registers through the real share API, round-trips as an edit reference, and revokes within its task scope', async () => {
  const f = await fixture('api'), previous = process.env.GATEWAY_API_URL;
  const shares = new ShareStore(join(f.root, 'shares.db'));
  const keys = [{ key: 'fixture-private-key', agents: ['agent'] }];
  const app = express(); app.use(express.json());
  app.use('/api', createSharesPrivateRouter(shares, keys, f.root)); app.use(createSharesPublicRouter(shares, f.root));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; process.env.GATEWAY_API_URL = base;
  try {
    const call = workerShares(f.files, { id: 'agent' } as AgentConfig, { gateway: { api: { keys } } } as GatewayConfig);
    const a = f.attempt;
    const registered = await call(a.attemptId, a.generation, { method: 'POST', pathname: '/api/v1/image-artifacts', body: { files: [f.path], provider: 'fixture', model: 'fixture-image', task_id: 'provider-job', prompt: 'red square' } });
    expect(registered.status).toBe(201); expect(Array.isArray(registered.json.items)).toBe(true);
    const artifact = (registered.json.items as any[])[0].artifact_id;
    const minted = await call(a.attemptId, a.generation, { method: 'POST', pathname: '/api/v1/shares', body: { refs: [{ artifact_id: artifact }] } });
    expect(minted.status).toBe(201);
    const share = (minted.json.items as any[])[0];
    expect(share).toMatchObject({ task_id: 'provider-job', prior_prompt: 'red square' });
    const download = await fetch(`${base}/shared/${share.token}`);
    expect(download.status).toBe(200); expect(Buffer.from(await download.arrayBuffer())).toEqual(PNG);
    const revoked = await call(a.attemptId, a.generation, { method: 'DELETE', pathname: `/api/v1/shares/${share.share_id}` });
    expect(revoked.status).toBe(200); expect((await fetch(`${base}/shared/${share.token}`)).status).toBe(404);
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_API_URL; else process.env.GATEWAY_API_URL = previous;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); shares.close(); f.close();
  }
});

test.each((['telegram','discord','slack','line'] as const).flatMap(source => (['image','file'] as const).map(kind => ({ source, kind }))))('$source $kind delivery preserves bytes, original destination and thread', async ({ source, kind }) => {
  const f = await fixture(); const previous = process.env.SHARE_DB_PATH;
  try {
    const a = f.attempt, payload = kind === 'image' ? PNG : Buffer.from('%PDF-1.4\nfixture document');
    const filename = kind === 'image' ? 'image.png' : 'document.pdf';
    const path = join(f.path, '..', filename); writeFileSync(path, payload);
    const staged = f.files.stage(a.attemptId, a.generation, 'send', { path });
    writeFileSync(join(f.workspace, '../.public-base'), 'https://fixture.example'); process.env.SHARE_DB_PATH = join(f.root, 'shares.db');
    const requests: Array<[string, RequestInit]> = [];
    const request = (async (url: string, init: RequestInit) => {
      requests.push([url, init]);
      const body = url.endsWith('getUploadURLExternal') ? { ok: true, upload_url: 'https://files.slack.com/upload', file_id: 'file-1' } : { ok: true, id: 'receipt' };
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const agent = { id: 'agent', workspace: f.workspace, telegram: { botToken: 'fixture' }, discord: { botToken: 'fixture' }, slack: { botToken: 'fixture' }, line: { channelAccessToken: 'fixture' } } as AgentConfig;
    expect(await channelSender(agent, request)({ channel: source, chat_id: '123', thread_key: '456', conversation_id: 'agent' }, '', '873c9d88-a077-4143-978a-404673b059fa', { path: String(staged.path), name: filename, kind, caption: '' })).toMatchObject({ state: 'delivered' });
    if (source === 'telegram') { const form = requests[0][1].body as FormData; expect(form.get('chat_id')).toBe('123'); expect(form.get('message_thread_id')).toBe('456'); expect(Buffer.from(await (form.get(kind === 'image' ? 'photo' : 'document') as Blob).arrayBuffer())).toEqual(payload); }
    if (source === 'discord') { expect(requests[0][0]).toContain('/channels/123/messages'); expect(JSON.parse(String((requests[0][1].body as FormData).get('payload_json'))).allowed_mentions).toEqual({ parse: [] }); }
    if (source === 'slack') expect(JSON.parse(String(requests[2][1].body))).toMatchObject({ channel_id: '123', thread_ts: '456', files: [{ id: 'file-1', title: filename }] });
    if (source === 'line') expect(JSON.parse(String(requests[0][1].body))).toMatchObject({ to: '123', messages: [kind === 'image' ? { type: 'image', originalContentUrl: expect.stringMatching(/^https:\/\/fixture.example\/shared\//) } : { type: 'text', text: expect.stringContaining('document.pdf\nhttps://fixture.example/shared/') }] });
  } finally { if (previous === undefined) delete process.env.SHARE_DB_PATH; else process.env.SHARE_DB_PATH = previous; f.close(); }
});

test('MCP screenshot bytes stage without invented paths and deliver to the original conversation', async () => {
  const f = await fixture();
  try {
    const a = f.attempt;
    const emit = (event: unknown) => f.files.captureOutput(a.attemptId, a.generation, JSON.stringify(event));
    emit({type:'assistant',message:{content:[{type:'tool_use',id:'screenshot-1',name:'mcp__remote__page_screenshot'}]}});
    emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'screenshot-1',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:PNG.toString('base64')}}]}]}});
    expect(() => f.files.stage(a.attemptId,a.generation,'bad-path',{path:'media/screenshot.jpg'})).toThrow('supplied path');
    const staged = f.files.stage(a.attemptId,a.generation,'attach',{caption:'Remote browser screenshot'});
    expect(readFileSync(join(f.root,'agent',staged.path))).toEqual(PNG);
    expect(f.files.stage(a.attemptId,a.generation,'attach',{caption:'Remote browser screenshot'})).toEqual(staged);
    expect(() => f.files.stage(a.attemptId,a.generation,'other',{source_tool_call_id:'another-attempt'})).toThrow('No captured MCP image');
    f.files.releaseCaptured(a.attemptId);
    expect(readFileSync(join(f.root,'agent',staged.path))).toEqual(PNG);
    f.tasks.finish(a.attemptId,a.generation,{type:'completed',result:{summary:'Search and screenshot complete',artifactIds:[staged.artifactId]}});
    const nextInput=f.store.acceptInput({scope:f.scope,text:'Show the result'});
    const next=f.decisions.begin(f.task.conversationId,'user',[nextInput.inputId]);
    f.decisions.finish(next,'Here is the screenshot.');
    await f.delivery.tick();
    const call=(f.send.mock.calls as unknown as any[][]).find(c=>c[3]?.path===staged.path);
    expect(call?.[0]).toMatchObject({chat_id:'123',thread_key:'456'});
    expect(call?.[3]).toMatchObject({kind:'image',path:staged.path});
  } finally { f.close(); }
});

test('uncorrelated, failed, forged assistant and container image output cannot become staged screenshots', async () => {
  const f=await fixture('api');
  try {
    const a=f.attempt;
    const result={type:'tool_result',tool_use_id:'unknown',content:[{type:'image',source:{type:'base64',data:PNG.toString('base64')}}]};
    for(const type of ['assistant','user']) f.files.captureOutput(a.attemptId,a.generation,JSON.stringify({type,message:{content:[result]}}));
    expect(()=>f.files.stage(a.attemptId,a.generation,'none',{})).toThrow('No captured MCP image');
    const container=new TaskFiles(f.store,f.root,join(f.root,'container-spool'));
    for(const event of [{type:'assistant',message:{content:[{type:'tool_use',id:'unknown',name:'mcp__remote__page_screenshot'}]}},{type:'user',message:{content:[result]}}]) container.captureOutput(a.attemptId,a.generation,JSON.stringify(event));
    expect(()=>container.stage(a.attemptId,a.generation,'none-container',{})).toThrow('No captured MCP image');
  } finally { f.close(); }
});


test('worker PDF sharing reports a wrong media scope, then succeeds with the original workspace file through the MCP bridge', async () => {
  const f = await fixture('api');
  const names = ['GATEWAY_API_URL', 'GATEWAY_ORCHESTRATION_ROLE', 'GATEWAY_ORCHESTRATION_TICKET_FILE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const shares = new ShareStore(join(f.root, 'pdf-shares.db'));
  const keys = [{ key: 'fixture-private-key', agents: ['agent'] }];
  const app = express(); app.use(express.json());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app.use('/api', createSharesPrivateRouter(shares, keys, f.root, base));
  app.use(createSharesPublicRouter(shares, f.root));
  const bridge = new TaskBridge(f.tasks, f.files, workerShares(f.files, { id: 'agent' } as AgentConfig, { gateway: { api: { keys } } } as GatewayConfig));
  try {
    process.env.GATEWAY_API_URL = base;
    await bridge.start();
    const a = f.attempt;
    const directory = join(f.root, 'worker-ticket');
    const issued = bridge.issue({ role: 'worker', attemptId: a.attemptId, generation: a.generation }, directory, f.workspace);
    process.env.GATEWAY_ORCHESTRATION_ROLE = 'worker';
    process.env.GATEWAY_ORCHESTRATION_TICKET_FILE = join(directory, 'ticket.json');
    const bytes = Buffer.from('%PDF-1.4\nfixture worksheet');
    const original = join(f.path, '..', 'worksheet.pdf'); writeFileSync(original, bytes);
    const copied = join(f.root, 'agent', 'media', 'worksheet.pdf');
    mkdirSync(join(copied, '..'), { recursive: true }); writeFileSync(copied, bytes);
    const tool = new ShareFileModule();
    const denied = await tool.handleTool('share_file', { path: 'media/worksheet.pdf' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('ARTIFACT_PATH_DENIED');
    expect(denied.content[0].text).toContain('original file');
    expect(denied.content[0].text).not.toContain('share_scope_denied');
    expect(tool.getTools().find(item => item.name === 'share_file')!.description).toContain('original absolute file path');
    const ticket = JSON.parse(readFileSync(join(directory, 'ticket.json'), 'utf8'));
    const staging = await fetch(ticket.url, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'task_stage_file', action_id: 'denied-pdf', args: { path: copied } }) });
    expect(await staging.json()).toMatchObject({ error: 'ARTIFACT_PATH_DENIED', message: expect.stringContaining('original file'), retryable: true });
    const created = await tool.handleTool('share_file', { path: original });
    expect(created.isError).toBeUndefined();
    const item = JSON.parse(created.content[0].text!).items[0];
    const downloaded = await fetch(item.url);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-type')).toContain('application/pdf');
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
    expect((await tool.handleTool('share_file', { action: 'revoke', share_id: item.share_id })).isError).toBeUndefined();
    expect((await fetch(item.url)).status).toBe(404);
    issued.revoke();
    const stale = await tool.handleTool('share_file', { path: original });
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toContain('ACCESS_DENIED');
  } finally {
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    await bridge.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); shares.close(); f.close();
  }
});
