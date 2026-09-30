import express from 'express';
import request from 'supertest';
import { createJevRouter } from '../../src/api/jev-router';
import { gatewayJev, jevAllowed } from '../../src/orchestration/jev-gateway';
import { AgentConfig, GatewayConfig } from '../../src/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dir=mkdtempSync(join(tmpdir(),'jev-api-'));
const agent={id:'alpha',jev:{enabled:true}} as AgentConfig;
const config={gateway:{logDir:join(dir,'logs'),jev:{enabled:true,provider:'typesafe',model:'jev-test'},api:{keys:[{key:'write-test-key',agents:['alpha'],write:true},{key:'read-test-key',agents:['alpha'],write:false}]}},agents:[agent]} as unknown as GatewayConfig;
const agents=new Map([['alpha',agent]]);
const app=express();app.use(express.json());app.use('/api',createJevRouter(config,agents));
afterAll(()=>{gatewayJev(config).close();rmSync(dir,{recursive:true,force:true});});
afterEach(()=>jest.restoreAllMocks());
const input={agentId:'alpha',state:'hello',questions:{match:{type:'noul',instructions:'Greeting?'}}};
test('unauthenticated, read-only and cross-agent callers cannot initiate paid evaluation',async()=>{
 const evaluate=jest.spyOn(gatewayJev(config).service,'evaluate');
 expect((await request(app).post('/api/v1/jev/evaluate').send(input)).status).toBe(401);
 expect((await request(app).post('/api/v1/jev/evaluate').set('Authorization','Bearer read-test-key').send(input)).status).toBe(403);
 expect((await request(app).post('/api/v1/jev/evaluate').set('Authorization','Bearer write-test-key').send({...input,agentId:'beta'})).status).toBe(403);
 expect(evaluate).not.toHaveBeenCalled();
});
test('trusted context is derived from credential; callers cannot inject principals, endpoints or billing source',async()=>{
 const evaluate=jest.spyOn(gatewayJev(config).service,'evaluate').mockResolvedValue({requestId:'r',requestedModel:'jev-test',model:'jev-test',answers:{match:{type:'noul',noul:1}},usage:{input_tokens:3,output_tokens:0}});
 for(const extra of [{principalId:'victim'},{baseUrl:'https://elsewhere.test'},{source:'managed'}]) {
  expect((await request(app).post('/api/v1/jev/evaluate').set('Authorization','Bearer write-test-key').send({...input,...extra})).status).toBe(400);
 }
 const r=await request(app).post('/api/v1/jev/evaluate').set('Authorization','Bearer write-test-key').send(input);
 expect(r.status).toBe(200);
 expect(evaluate.mock.calls[0][1]).toEqual(expect.objectContaining({agentId:'alpha',consumer:'api',principalId:expect.any(String)}));
 expect(evaluate.mock.calls[0][1].principalId).not.toBe('write-test-key');
 const auth=evaluate.mock.calls[0][1].authorize!;expect(auth()).toBe(true);
 config.gateway.jev!.allowedAgentIds=[];expect(auth()).toBe(false);delete config.gateway.jev!.allowedAgentIds;
 agent.jev!.enabled=false;expect(auth()).toBe(false);agent.jev!.enabled=true;
});
test('usage is agent-scoped, paginated and never returned without auth',async()=>{
 expect((await request(app).get('/api/v1/jev/usage?agentId=alpha')).status).toBe(401);
 expect((await request(app).get('/api/v1/jev/usage?agentId=beta').set('Authorization','Bearer write-test-key')).status).toBe(403);
 expect((await request(app).get('/api/v1/jev/usage?agentId=alpha&limit=10000').set('Authorization','Bearer write-test-key')).status).toBe(400);
 const r=await request(app).get('/api/v1/jev/usage?agentId=alpha').set('Authorization','Bearer read-test-key');
 expect(r.status).toBe(200);expect(r.body).toEqual({records:[],total:0});expect(r.headers['cache-control']).toBe('no-store');
});
test('global enable and per-agent disable never expand access',()=>{
 expect(jevAllowed(config,agent)).toBe(true);
 config.gateway.jev!.enabled=false;expect(jevAllowed(config,agent)).toBe(false);config.gateway.jev!.enabled=true;
 config.gateway.jev!.allowedAgentIds=['beta'];expect(jevAllowed(config,agent)).toBe(false);delete config.gateway.jev!.allowedAgentIds;
});
