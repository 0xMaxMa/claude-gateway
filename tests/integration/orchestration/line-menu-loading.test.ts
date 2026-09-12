import express from 'express';
import { createHmac } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLineWebhookHandler } from '../../../src/api/line-webhook-router';
import { sendControlMenu } from '../../../src/orchestration/control-delivery';
import { AgentRunner } from '../../../src/agent/runner';
import { AgentConfig } from '../../../src/types';

// Real SDK + signed webhook + HTTP callback + menu delivery; delay the loading
// response to reproduce the ordering race for all directly handled menus.
test.each(['/voice', '/voices', '/tasks', '/stop', '/session', '/sessions', '/help', '/new'])('%s cannot leave a late ingress loading request after its reply', async command => {
  const root = mkdtempSync(join(tmpdir(), 'line-order-')), calls: string[] = [];
  let release!: () => void, seen!: () => void;
  const loadingSeen = new Promise<void>(resolve => { seen = resolve; });
  const loadingRelease = new Promise<void>(resolve => { release = resolve; });
  const agent = { id: 'a', workspace: join(root, 'workspace'), orchestration: { enabled: true }, line: { channelSecret: 'secret', channelAccessToken: 'fixture', dmPolicy: 'open' } } as AgentConfig;
  const app = express(); app.use(express.json());
  app.post('/v2/bot/chat/loading/start', async (_req, res) => { calls.push('loading-start'); seen(); await loadingRelease; calls.push('loading-end'); res.status(202).json({}); });
  app.post('/v2/bot/message/reply', (_req, res) => { calls.push('reply'); res.json({}); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve));
  const port = (server.address() as {port:number}).port, base = `http://127.0.0.1:${port}`;
  app.post('/channel', async (req, res) => {
    calls.push('forward');
    await sendControlMenu(agent, 'line', 'Ufixture', { text: 'Menu', buttons: [{ label: 'Dismiss', data: 'orch:fixture' }] }, req.body.meta,
      ((url, init) => fetch(String(url).replace('https://api.line.me', base), init)) as typeof fetch);
    res.send('ok');
  });
  const runner = { getAgentConfig: () => agent, getGatewayPublicUrl: () => base, getCallbackPort: () => port } as unknown as AgentRunner;
  const handler = createLineWebhookHandler(new Map([['a',runner]]), root, {apiBase:base});
  const body = Buffer.from(JSON.stringify({events:[{type:'message',replyToken:'fixture',source:{type:'user',userId:'Ufixture'},message:{type:'text',id:'m',text:command}}]}));
  const sig = createHmac('sha256','secret').update(body).digest('base64');
  const req = { params:{appId:'a',agentId:'a'}, headers:{}, body, header:(name:string)=>name==='x-line-signature'?sig:undefined };
  const res:any = {headersSent:false,status(){return this;},json(){this.headersSent=true;return this;}};
  try {
    const handling = handler.handlePost(req as any,res);
    await loadingSeen;
    // Give the callback time to overtake the deliberately blocked loading call.
    await new Promise(resolve => setTimeout(resolve,30));
    expect(calls).toEqual(['loading-start']);
    release(); await handling;
    expect(calls).toEqual(['loading-start','loading-end','forward','reply']);
  } finally { release(); await new Promise<void>(resolve => server.close(()=>resolve())); rmSync(root,{recursive:true,force:true}); }
});
