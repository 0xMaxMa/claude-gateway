import { ORCHESTRATION_DEFAULTS } from '../../../src/orchestration/config';
import express from 'express';
import request from 'supertest';
import { createServer, request as httpRequest } from 'http';
import { once } from 'events';
import WebSocket from 'ws';
import { VoiceApi } from '../../../src/api/voice-router';
import { FakeSttProvider, FakeTtsProvider } from '../../../src/voice/providers/fake';
import type { AgentConfig } from '../../../src/types';
import type { AgentRunner } from '../../../src/agent/runner';

jest.mock('../../../src/voice/providers/voice-catalog', () => ({
  resolveVoiceId: async (config: {voiceId: string}) => config.voiceId || 'fixture',
  voiceChoices: async () => [{ id: 'fixture', name: 'Default' }, { id: 'alternate', name: 'Alternate' }],
}));

jest.mock('../../../src/voice/providers/registry', () => ({
  sttProvider: jest.fn(() => new FakeSttProvider()), ttsProvider: () => new FakeTtsProvider(),
}));

test('voice ticket requires scoped auth and origin-bound tickets without URL registration, is single-use, and releases its mic lease on disconnect', async () => {
  const agent = { id: 'a', orchestration: { enabled: true }, voice: { ...ORCHESTRATION_DEFAULTS.voice, enabled: true, tts: { ...ORCHESTRATION_DEFAULTS.voice.tts, voiceId: 'fixture' } } } as AgentConfig;
  const runner = { setBrowserVoice: async () => {}, pendingVoiceSpeech: async () => [], subscribeVoiceResults: async () => () => {}, apiSessionExists: async () => true, authorizeVoiceSession: async () => {}, submitVoiceUtterance: jest.fn(), stopVoiceResponse: jest.fn(), recordVoicePlayback: jest.fn() } as unknown as AgentRunner;
  const api = new VoiceApi(new Map([['a', runner]]), new Map([['a', agent]]), [{ id: 'owner', key: 'fixture', agents: ['a'] }]);
  const app = express(); app.use(express.json()); app.use('/api', api.router);
  const server = createServer(app); server.on('upgrade', (req, socket, head) => { api.upgrade(req, socket, head); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const endpoint = '/api/v1/agents/a/sessions/p/voice-sessions';
  let ws: WebSocket | undefined;
  try {
    const catalogPath = '/api/v1/agents/a/voice-sessions/voices';
    expect((await request(app).get(catalogPath)).status).toBe(401);
    expect((await request(app).get(catalogPath).set('Authorization', 'Bearer fixture').set('Origin', 'https://new-client.example')).status).toBe(200);
    const catalog = await request(app).get(catalogPath).set('Authorization', 'Bearer fixture');
    expect(catalog.body.voices.map((v: { id: string }) => v.id)).toEqual(['fixture', 'alternate']);
    expect((await request(app).post(endpoint).send({ chat_id: 'c' })).status).toBe(401);
    expect((await request(app).post(endpoint).set('Cookie', 'session=not-an-api-key').set('Origin', 'https://evil.example').send({ chat_id: 'c' })).status).toBe(401);
    const preflight = await request(app).options(endpoint).set('Origin', 'https://client.example');
    expect(preflight.status).toBe(204); expect(preflight.headers['access-control-allow-origin']).toBe('*'); expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    // The ticket is consumed before ws validates the handshake. A rejection must
    // release its lease even though no VoiceSession was ever constructed.
    const bad = await request(app).post(endpoint).set('Authorization', 'Bearer fixture').send({ chat_id: 'c' });
    expect(bad.status).toBe(200);
    const handshakeStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: `${bad.body.stream_path}?ticket=${bad.body.ticket}`,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '12' } }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode));
      });
      req.once('error', reject); req.end();
    });
    expect(handshakeStatus).toBe(400);
    await new Promise(resolve => setImmediate(resolve));
    const ticket = await request(app).post(endpoint).set('Authorization', 'Bearer fixture').set('Origin', 'https://client.example').send({ chat_id: 'c' });
    expect(ticket.status).toBe(200);
    expect((await request(app).post(endpoint).set('Authorization', 'Bearer fixture').send({ chat_id: 'c' })).status).toBe(409);
    const url = `ws://127.0.0.1:${port}${ticket.body.stream_path}?ticket=${ticket.body.ticket}`;
    const wrongOrigin = new WebSocket(url, { origin: 'https://other.example' });
    const originRejected = await new Promise<Error>(resolve => wrongOrigin.once('error', resolve));
    expect(originRejected.message).toContain('403');
    ws = new WebSocket(url, { origin: 'https://client.example' });
    const ready = once(ws, 'message'); await once(ws, 'open');
    expect(JSON.parse(String((await ready)[0])).state).toBe('ready');
    const listening = once(ws, 'message'); ws.send(JSON.stringify({ type: 'voice.start' })); await listening;
    const configured = once(ws, 'message'); ws.send(JSON.stringify({ type: 'voice.configure', voice_id: 'alternate' }));
    expect(JSON.parse(String((await configured)[0]))).toMatchObject({ type: 'voice.configured', voice_id: 'alternate' });
    const modelChanged = once(ws, 'message'); ws.send(JSON.stringify({ type: 'voice.configure', model: 'gpt-6-astra' }));
    expect(JSON.parse(String((await modelChanged)[0]))).toMatchObject({ type: 'voice.configured', model: 'gpt-6-astra' });
    const invalid = once(ws, 'message'); ws.send(JSON.stringify({ type: 'voice.configure', voice_id: 'unknown' }));
    expect(JSON.parse(String((await invalid)[0]))).toMatchObject({ type: 'voice.error', code: 'INVALID_CONTROL' });
    const replay = new WebSocket(url, { origin: 'https://client.example' });
    const rejected = await new Promise<Error>(resolve => replay.once('error', resolve));
    expect(rejected.message).toContain('403');
    const closed = once(ws, 'close'); ws.close(); await closed;
    // Browser cleanup follows the WebSocket close; the server has already retired it.
    expect((await request(app).delete(`${endpoint}/${ticket.body.voice_session_id}`).set('Authorization', 'Bearer fixture')).status).toBe(404);
    const replacement = await request(app).post(endpoint).set('Authorization', 'Bearer fixture').send({ chat_id: 'c' });
    expect(replacement.status).toBe(200);
  } finally { ws?.terminate(); await api.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('STT disconnect closes with a retryable transport code and a new ticket opens a fresh recognizer',async()=>{
 const {sttProvider}=await import('../../../src/voice/providers/registry');
 const factory=sttProvider as jest.Mock;
 const agent={id:'a',orchestration:{enabled:true},voice:{...ORCHESTRATION_DEFAULTS.voice,enabled:true}} as AgentConfig;
 const runner={setBrowserVoice: async () => {}, pendingVoiceSpeech: async () => [], subscribeVoiceResults:async()=>()=>{},apiSessionExists:async()=>true,authorizeVoiceSession:async()=>{},stopVoiceResponse:jest.fn(),recordVoicePlayback:jest.fn()} as unknown as AgentRunner;
 const api=new VoiceApi(new Map([['a',runner]]),new Map([['a',agent]]),[{id:'owner',key:'fixture',agents:['a']}]);
 const app=express();app.use(express.json());app.use('/api',api.router);
 const server=createServer(app);server.on('upgrade',(req,socket,head)=>{api.upgrade(req,socket,head);});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=(server.address() as {port:number}).port;let ws:WebSocket|undefined;
 const connect=async()=>{
  const ticket=await request(app).post('/api/v1/agents/a/sessions/s/voice-sessions').set('Authorization','Bearer fixture').send({chat_id:'c'});
  expect(ticket.status).toBe(200);
  ws=new WebSocket(`ws://127.0.0.1:${port}${ticket.body.stream_path}?ticket=${ticket.body.ticket}`);
  await once(ws,'message');
  const listening=new Promise<void>(resolve=>{ const onMessage=(data:WebSocket.RawData)=>{
   if(JSON.parse(String(data)).state==='listening'){ws!.off('message',onMessage);resolve();}
  };ws!.on('message',onMessage);});
  ws.send(JSON.stringify({type:'voice.start'}));await listening;
 };
 try {
  await connect();const provider=factory.mock.results.at(-1)!.value as FakeSttProvider;
  const notice=once(ws!,'message'),closed=once(ws!,'close');
  provider.sessions[0].emit({type:'error',code:'STT_CONNECTION_CLOSED',retryable:true});
  expect(JSON.parse(String((await notice)[0]))).toMatchObject({type:'voice.notice',retryable:true});
  expect((await closed)[0]).toBe(1012);
  await new Promise(resolve=>setImmediate(resolve));await connect();
  expect(factory.mock.results.at(-1)!.value).not.toBe(provider);
  expect(runner.stopVoiceResponse).not.toHaveBeenCalled();
 }finally{ws?.terminate();await api.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('a failed STT handshake releases the lease and requests a fresh connection',async()=>{
 const {sttProvider}=await import('../../../src/voice/providers/registry');
 const {VoiceError}=await import('../../../src/voice/types');
 const stt=new FakeSttProvider();
 jest.spyOn(stt,'open').mockRejectedValue(new VoiceError('STT_PROVIDER_ERROR_HTTP_503'));
 (sttProvider as jest.Mock).mockReturnValueOnce(stt);
 const agent={id:'a',orchestration:{enabled:true},voice:{...ORCHESTRATION_DEFAULTS.voice,enabled:true}} as AgentConfig;
 const runner={setBrowserVoice: async () => {}, pendingVoiceSpeech: async () => [], subscribeVoiceResults:async()=>()=>{},apiSessionExists:async()=>true,authorizeVoiceSession:async()=>{},stopVoiceResponse:jest.fn(),recordVoicePlayback:jest.fn()} as unknown as AgentRunner;
 const api=new VoiceApi(new Map([['a',runner]]),new Map([['a',agent]]),[{id:'owner',key:'fixture',agents:['a']}]);
 const app=express();app.use(express.json());app.use('/api',api.router);
 const server=createServer(app);server.on('upgrade',(req,socket,head)=>{api.upgrade(req,socket,head);});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const endpoint='/api/v1/agents/a/sessions/s/voice-sessions';
 let ws:WebSocket|undefined;
 try{
  const ticket=await request(app).post(endpoint).set('Authorization','Bearer fixture').send({chat_id:'c'});
  expect(ticket.status).toBe(200);
  ws=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}${ticket.body.stream_path}?ticket=${ticket.body.ticket}`);
  await once(ws,'message');
  const messages:any[]=[];ws.on('message',data=>messages.push(JSON.parse(String(data))));
  const closed=once(ws,'close');ws.send(JSON.stringify({type:'voice.start'}));
  expect((await closed)[0]).toBe(1012);
  expect(messages).toContainEqual(expect.objectContaining({type:'voice.notice',code:'STT_PROVIDER_ERROR_HTTP_503',reconnect:true,retryable:true}));
  expect(messages.some(m=>m.state==='listening')).toBe(false);
  expect((await request(app).post(endpoint).set('Authorization','Bearer fixture').send({chat_id:'c'})).status).toBe(200);
  expect(runner.stopVoiceResponse).not.toHaveBeenCalled();
 }finally{ws?.terminate();await api.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('returning muted plays missed and later speech once, and preference/ticket writes retain auth and lease exclusion', async () => {
  const agent = {id:'a', orchestration:{enabled:true}, voice:{...ORCHESTRATION_DEFAULTS.voice,enabled:true}} as AgentConfig;
  const pending = [{responseId:'missed',text:'Display',spoken:'Speak'}];
  const runner = {
    setBrowserVoice: jest.fn(async () => { await new Promise(resolve => setImmediate(resolve)); }),
    pendingVoiceSpeech: async () => pending,
    subscribeVoiceResults: async () => () => {}, apiSessionExists: async () => true,
    authorizeVoiceSession: async () => {}, stopVoiceResponse: jest.fn(), recordVoicePlayback: jest.fn(),
  } as unknown as AgentRunner;
  const api = new VoiceApi(new Map([['a',runner]]),new Map([['a',agent]]),[{id:'owner',key:'fixture',agents:['a']}]);
  const app=express(); app.use(express.json()); app.use('/api',api.router);
  const server=createServer(app); server.on('upgrade',(req,socket,head)=>{api.upgrade(req,socket,head);});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const endpoint='/api/v1/agents/a/sessions/s/voice-sessions';
  let ws:WebSocket|undefined;
  const waitFor=async(predicate:()=>boolean)=>{const deadline=Date.now()+3500;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));expect(predicate()).toBe(true);};
  try {
    expect((await request(app).put(`${endpoint}/preference`).send({enabled:false})).status).toBe(401);
    expect((await request(app).put(`${endpoint}/preference`).set('Authorization','Bearer fixture').send({enabled:true})).status).toBe(400);
    const tickets=await Promise.all([0,1].map(()=>request(app).post(endpoint).set('Authorization','Bearer fixture').send({chat_id:'c'})));
    expect(tickets.map(t=>t.status).sort()).toEqual([200,409]);
    const ticket=tickets.find(t=>t.status===200)!;
    ws=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}${ticket.body.stream_path}?ticket=${ticket.body.ticket}`);
    const controls:any[]=[];
    ws.on('message',(data,binary)=>{
      if(!binary){controls.push(JSON.parse(String(data)));return;}
      const {decodeVoiceFrame}=require('../../../src/voice/protocol');
      const frame=decodeVoiceFrame(Buffer.from(data as Buffer));
      ws!.send(JSON.stringify({type:'playback.progress',epoch:frame.epoch,sample_offset:frame.audio.length/2}));
    });
    await once(ws,'open'); await waitFor(()=>controls.some(c=>c.state==='ready'));
    ws.send(JSON.stringify({type:'voice.start',muted:true}));
    await waitFor(()=>controls.some(c=>c.type==='playback.end'));
    expect(controls.some(c=>c.state==='muted')).toBe(true);
    expect(controls.some(c=>c.state==='listening')).toBe(false);
    pending.push({responseId:'finished-after-return',text:'Later',spoken:'Later speech'});
    await waitFor(()=>controls.filter(c=>c.type==='playback.end').length===2);
    expect(controls.filter(c=>c.type==='playback.start').map(c=>c.response_id)).toEqual(['missed','finished-after-return']);
    expect((await request(app).put(`${endpoint}/preference`).set('Authorization','Bearer fixture').send({enabled:false})).status).toBe(204);
    expect(runner.setBrowserVoice).toHaveBeenLastCalledWith('s','api:owner',false);
  } finally {ws?.terminate();await api.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('confirmed voice words pause the selected task once, retain its target across a selection change, and speak the correction ACK',async()=>{
  const {sttProvider}=require('../../../src/voice/providers/registry');
  const stt=new FakeSttProvider();sttProvider.mockReturnValueOnce(stt);
  const {encodeVoiceFrame}=require('../../../src/voice/protocol');
  const agent={id:'a',allow_tools:true,orchestration:{enabled:true},voice:{...ORCHESTRATION_DEFAULTS.voice,enabled:true,tts:{...ORCHESTRATION_DEFAULTS.voice.tts,voiceId:'fixture'}}} as AgentConfig;
  const responseId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const submit=jest.fn(async()=>({inputId:'input',response:Promise.resolve('Correction accepted.'),responseId:()=>responseId,stream:(async function*(){yield {responseId,text:'Correction accepted.'};})()}));
  const pause=jest.fn(async()=>{});
  const runner={setBrowserVoice:async()=>{},pendingVoiceSpeech:async()=>[],subscribeVoiceResults:async()=>()=>{},apiSessionExists:async()=>true,authorizeVoiceSession:async()=>{},submitVoiceUtterance:submit,pauseVoiceExecution:pause,stopVoiceResponse:jest.fn(),recordVoicePlayback:jest.fn(),saveVoiceReplay:jest.fn()} as unknown as AgentRunner;
  const api=new VoiceApi(new Map([['a',runner]]),new Map([['a',agent]]),[{id:'owner',key:'fixture',agents:['a'],allow_tools:true}]);
  const app=express();app.use(express.json());app.use('/api',api.router);
  const server=createServer(app);server.on('upgrade',(req,socket,head)=>api.upgrade(req,socket,head));server.listen(0,'127.0.0.1');await once(server,'listening');
  let ws:WebSocket|undefined;const events:any[]=[],audio:Buffer[]=[];
  const until=async(fn:()=>boolean)=>{const start=Date.now();while(!fn()){if(Date.now()-start>5000)throw Error('voice fixture timeout');await new Promise(r=>setTimeout(r,5));}};
  try{
    const ticket=await request(app).post('/api/v1/agents/a/sessions/p/voice-sessions').set('Authorization','Bearer fixture').send({chat_id:'c'});
    ws=new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}${ticket.body.stream_path}?ticket=${ticket.body.ticket}`);
    ws.on('message',(data,binary)=>binary?audio.push(Buffer.from(data as Buffer)):events.push(JSON.parse(String(data))));
    await until(()=>events.some(e=>e.state==='ready'));
    const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
    ws.send(JSON.stringify({type:'voice.start',execution_task_id:first}));
    await until(()=>events.some(e=>e.state==='listening'));
    const listening=events.find(e=>e.state==='listening');
    ws.send(encodeVoiceFrame({generation:listening.generation,epoch:0,sequence:1,segmentId:listening.utterance_id,audio:Buffer.alloc(640)}));
    await until(()=>stt.sessions[0].frames.length===1);
    expect(pause).not.toHaveBeenCalled();
    stt.sessions[0].emit({type:'partial',segmentId:'segment',text:'Manchester'});
    await until(()=>pause.mock.calls.length===1);
    ws.send(JSON.stringify({type:'voice.configure',execution_task_id:second}));
    ws.send(JSON.stringify({type:'utterance.commit',last_audio_seq:1,final:true}));
    await until(()=>Boolean(stt.sessions[0].commitId));
    stt.sessions[0].emit({type:'segment_final',segmentId:'segment',text:'Manchester instead'});
    stt.sessions[0].emit({type:'commit_done',commitId:stt.sessions[0].commitId!});
    await until(()=>submit.mock.calls.length===1&&audio.length>0);
    expect((submit.mock.calls[0] as unknown[])[7]).toBe(first);
    expect((pause.mock.calls[0] as unknown[])[2]).toBe(first);expect(pause).toHaveBeenCalledTimes(1);
    expect(events.some(e=>e.type==='utterance.accepted')).toBe(true);
    // A discarded partial belongs to neither the next task nor the next utterance.
    stt.sessions[0].emit({type:'partial',segmentId:'discarded',text:'Discard this'});
    await until(()=>pause.mock.calls.length===2);
    ws.send(JSON.stringify({type:'voice.mute',muted:true,policy:'discard',last_audio_seq:0}));
    await until(()=>events.some(e=>e.state==='muted'));
    const third='33333333-3333-4333-8333-333333333333';
    ws.send(JSON.stringify({type:'voice.configure',execution_task_id:third}));
    const listeningCount=events.filter(e=>e.state==='listening').length;
    ws.send(JSON.stringify({type:'voice.mute',muted:false,policy:'discard',last_audio_seq:0}));
    await until(()=>events.filter(e=>e.state==='listening').length>listeningCount);
    stt.sessions.at(-1)!.emit({type:'partial',segmentId:'new-speech',text:'New correction'});
    await until(()=>pause.mock.calls.length===3);
    expect((pause.mock.calls[2] as unknown[])[2]).toBe(third);
    expect(events.filter(e=>e.type==='voice.error')).toEqual([]);

  }finally{ws?.terminate();await api.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
