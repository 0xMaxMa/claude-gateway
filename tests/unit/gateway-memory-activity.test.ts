import * as dreamingAccept from '../../src/agent/dreaming/accept';
import supertest from 'supertest';
import { GatewayRouter } from '../../src/api/gateway-router';
import { AgentRunner } from '../../src/agent/runner';
import { generateDashboardHtml } from '../../src/ui/web-ui';
import { memoryActivityClient } from '../../src/ui/memory-activity';

function setup(timezone='UTC') {
 const runs=Array.from({length:30},(_,i)=>({id:'run-'+i,agent:'agent',kind:'session_compaction',startedAt:Date.now()-i*1000,endedAt:null,status:i===0?'failed':'completed',config:{thresholdPercent:70,quietMinutes:30,maxSessionsPerRun:4},items:[{sessionId:'session',status:'completed',beforeTokens:100,afterTokens:null,contextWindow:200,startedAt:1,endedAt:2}]}));
 const sessionCompactionReport=jest.fn().mockResolvedValue({runs,schedule:{enabled:true,nextRunAt:Date.now()+10000,timezone:'UTC',thresholdPercent:70,quietMinutes:30,maxSessionsPerRun:4}});
 const router=new GatewayRouter(new Map([['agent',{sessionCompactionReport,workspacePath:'/tmp/custom-memory-workspace'} as unknown as AgentRunner]]),new Map(),undefined,{gateway:{bind:'127.0.0.1',logDir:'/tmp',timezone,api:{keys:[{key:'admin',admin:true,agents:'*'},{key:'scoped',agents:['agent']}]}},agents:[]});
 return {app:router.getApp(),sessionCompactionReport};
}
test('memory activity requires admin before invoking a runner',async()=>{
 const {app,sessionCompactionReport}=setup();
 for(const key of ['', 'scoped'])expect((await supertest(app).get('/dashboard/memory-activity').set('X-Api-Key',key)).status).toBe(401);
 expect(sessionCompactionReport).not.toHaveBeenCalled();
});
test('memory activity pages newest first, projects lists, and enforces detail ownership',async()=>{
 const {app,sessionCompactionReport}=setup();
 const get=(query:any)=>supertest(app).get('/dashboard/memory-activity').set('X-Api-Key','admin').query({scope:'all',...query});
 const first=await get({});expect(first.status).toBe(200);expect(first.headers['cache-control']).toBe('no-store');expect(first.body.total).toBe(30);expect(first.body.runs).toHaveLength(25);expect(first.body.runs[0].id).toBe('run-0');expect(first.body.runs[0].items).toBeUndefined();
 const second=await get({page:1});expect(second.body.runs).toHaveLength(5);expect(second.body.runs[0].id).toBe('run-25');
 const filtered=await get({status:'failed',kind:'session_compaction'});expect(filtered.body.total).toBe(1);
 expect((await get({id:'run-0'})).status).toBe(404);
 const detail=await get({id:'run-0',agentId:'agent'});expect(detail.body.run.items[0].afterTokens).toBeNull();
 expect((await get({id:'run-0',agentId:'wrong'})).status).toBe(404);
 expect(sessionCompactionReport).toHaveBeenCalledTimes(1);
});
test.each([{page:-1},{page:'NaN'},{page:1.5},{kind:'bad'},{scope:'bad'},{agentId:['a','b']}])('rejects invalid query %j',async query=>{
 const {app,sessionCompactionReport}=setup();expect((await supertest(app).get('/dashboard/memory-activity').set('X-Api-Key','admin').query(query)).status).toBe(400);expect(sessionCompactionReport).not.toHaveBeenCalled();
});
test('dashboard exposes compact maintenance filters and executable client',()=>{
 const html=generateDashboardHtml();expect(html).toContain('memory-kind');expect(html).toContain('Session Compaction');expect(html).toContain('memory-drawer');
 expect(()=>new Function(memoryActivityClient)).not.toThrow();
 expect(memoryActivityClient).toContain("txt(p.content)");expect(memoryActivityClient).toContain('/knowledge/dreams/apply');
});

test('proposal application resolves the configured runner workspace',async()=>{
 const accept=jest.spyOn(dreamingAccept,'acceptDreamProposals').mockReturnValue({requested:1,applied:1,skipped:0,alreadyAccepted:0,files:[],backups:[]});
 try{const {app}=setup();const response=await supertest(app).post('/knowledge/dreams/apply').set('X-Api-Key','admin').send({agentId:'agent',ts:1,indexes:[0]});expect(response.status).toBe(200);expect(accept).toHaveBeenCalledWith('/tmp/custom-memory-workspace',1,[0],expect.any(Object));}finally{accept.mockRestore();}
});

test('24h includes overnight runs in the configured timezone and hides empty sweeps',async()=>{
 const now=jest.spyOn(Date,'now').mockReturnValue(Date.parse('2026-09-19T01:00:00Z'));
 try {
 const {app,sessionCompactionReport}=setup('Asia/Bangkok');
 sessionCompactionReport.mockResolvedValue({runs:[
 {id:'done',agent:'agent',kind:'session_compaction',startedAt:Date.parse('2026-09-18T20:00:00Z'),status:'completed',items:[{sessionId:'s',status:'completed',beforeTokens:653464,afterTokens:4191,contextWindow:1000000}]},
 {id:'empty',agent:'agent',kind:'session_compaction',startedAt:Date.now(),status:'completed',items:[]},
 {id:'previous-day',agent:'agent',kind:'session_compaction',startedAt:Date.parse('2026-09-18T16:59:59Z'),status:'completed',items:[{status:'completed',beforeTokens:1,afterTokens:1,contextWindow:100}]}
 ]});
 const response=await supertest(app).get('/dashboard/memory-activity').set('X-Api-Key','admin').query({scope:'24h',completedOnly:'true'});
 expect(response.status).toBe(200);expect(response.body.timezone).toBe('Asia/Bangkok');expect(response.body.runs.map((r:any)=>r.id)).toEqual(['done']);
 expect(response.body.runs[0]).toMatchObject({beforeTokens:653464,afterTokens:4191,measuredReduction:649273});
 }finally{now.mockRestore();}
});

test('status selections filter before pagination and summary counts',async()=>{
 const {app}=setup();
 const get=(status:string)=>supertest(app).get('/dashboard/memory-activity').set('X-Api-Key','admin').query({scope:'all',status});
 const both=await get('completed,failed');expect(both.body.total).toBe(30);expect(both.body.counts.failed).toBe(1);
 const failed=await get('failed,running');expect(failed.body.total).toBe(1);expect(failed.body.runs[0].status).toBe('failed');
 expect((await get('none')).body.total).toBe(0);
 expect((await get('completed,invalid')).status).toBe(400);
});
