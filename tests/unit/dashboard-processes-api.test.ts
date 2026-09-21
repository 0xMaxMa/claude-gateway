jest.mock('../../src/api/dashboard-processes',()=>({collectDashboardProcesses:jest.fn()}));
import { collectDashboardProcesses } from '../../src/api/dashboard-processes';
import { GatewayRouter } from '../../src/api/gateway-router';
import supertest from 'supertest';
import type { GatewayConfig } from '../../src/types';
const key='fixture-admin-key';
const snapshot={processes:[],containers:[],warnings:[]};
function app(){
 const config={agents:[],gateway:{logDir:'/tmp',timezone:'UTC',api:{keys:[{key,admin:true,agents:'*'}]}}} as GatewayConfig;
 return new GatewayRouter(new Map(),new Map(),undefined,config).getApp();
}
afterEach(()=>jest.resetAllMocks());
test('requires admin auth before process collection',async()=>{
 const response=await supertest(app()).get('/processes');
 expect(response.status).toBe(401);expect(collectDashboardProcesses).not.toHaveBeenCalled();
});
test('coalesces concurrent polls, then serves the cached result',async()=>{
 let finish!:(value:typeof snapshot)=>void;
 jest.mocked(collectDashboardProcesses).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const server=app();
 const request=()=>supertest(server).get('/processes').set('X-Api-Key',key).then(r=>r);
 const first=request(),second=request();
 while(!finish)await new Promise(resolve=>setTimeout(resolve,5));
 await new Promise(resolve=>setTimeout(resolve,20));
 expect(collectDashboardProcesses).toHaveBeenCalledTimes(1);finish(snapshot);
 const responses=await Promise.all([first,second]);
 expect(responses.every(r=>r.status===200&&Array.isArray(r.body.containers))).toBe(true);
 expect((await request()).status).toBe(200);expect(collectDashboardProcesses).toHaveBeenCalledTimes(1);
});
test('failed collection returns a safe error and does not poison the next request',async()=>{
 jest.mocked(collectDashboardProcesses).mockRejectedValueOnce(new Error('private command content')).mockResolvedValue(snapshot);
 const server=app();
 const first=await supertest(server).get('/processes').set('X-Api-Key',key);
 expect(first.status).toBe(503);expect(JSON.stringify(first.body)).not.toContain('private');
 expect((await supertest(server).get('/processes').set('X-Api-Key',key)).status).toBe(200);
});
