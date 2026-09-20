import {mkdtempSync, rmSync, readFileSync, statSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import supertest from 'supertest';
import {DashboardSessions} from '../../src/api/dashboard-sessions';
import {GatewayRouter} from '../../src/api/gateway-router';
import type {ApiKey, GatewayConfig} from '../../src/types';
const keys:ApiKey[]=[{key:'test-admin-one',admin:true,agents:'*',description:'fixture'},{key:'test-admin-two',admin:true,agents:'*',description:'fixture'}];
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'dashboard-login-'));});
afterEach(()=>{jest.restoreAllMocks();rmSync(root,{recursive:true,force:true});});
test('sessions survive reopen without storing cookie or admin keys in plaintext; logout survives reopen',()=>{
 const file=join(root,'sessions.db');let store=new DashboardSessions(file);
 const token=store.issue(keys[0].key,8000);store.close();
 expect(statSync(file).mode&0o777).toBe(0o600);
 const data=readFileSync(file).toString();expect(data).not.toContain(token);expect(data).not.toContain(keys[0].key);
 store=new DashboardSessions(file);expect(store.valid(token,keys)).toBe(true);
 store.revoke(token);store.close();store=new DashboardSessions(file);
 expect(store.valid(token,keys)).toBe(false);store.close();
});
test('restart and requests do not extend expiry; a forged cookie is rejected',()=>{
 const clock=jest.spyOn(Date,'now').mockReturnValue(1000);const file=join(root,'sessions.db');let store=new DashboardSessions(file);
 const token=store.issue(keys[0].key,8000);store.close();clock.mockReturnValue(8999);store=new DashboardSessions(file);
 expect(store.valid(token,keys)).toBe(true);expect(store.valid('f'.repeat(64),keys)).toBe(false);
 store.close();clock.mockReturnValue(9000);store=new DashboardSessions(file);expect(store.valid(token,keys)).toBe(false);store.close();
});
test.each(['remove','rotate','demote'])('%s invalidates only the issuing admin key sessions',kind=>{
 const store=new DashboardSessions(join(root,'sessions.db'));const one=store.issue(keys[0].key,8000),two=store.issue(keys[1].key,8000);
 const updated=kind==='remove'?[keys[1]]:[{...keys[0],...(kind==='rotate'?{key:'rotated'}:{admin:false})},keys[1]];
 expect(store.valid(one,updated)).toBe(false);expect(store.valid(two,updated)).toBe(true);
 expect(store.valid(one,keys)).toBe(false);store.close();
});
function router(){return new GatewayRouter(new Map(),new Map(),undefined,{gateway:{logDir:root,timezone:'UTC',api:{keys}},agents:[]} as GatewayConfig,undefined,join(root,'config.json'));}
test('real HTTP login survives router restart, protects report routes, and logout stays revoked',async()=>{
 let server=router();let token:string;
 try{
 const response=await supertest(server.getApp()).post('/dashboard/login').send({key:keys[0].key}).expect(200);
 token=response.headers['set-cookie'][0].split(';')[0];
 }finally{await server.stop();}
 server=router();try{
 await supertest(server.getApp()).get('/status').set('Cookie',token!).expect(200);
 const page=await supertest(server.getApp()).get('/dashboard').set('Cookie',token!).expect(200);
 expect(page.text).not.toContain('Sign in with your admin API key');
 await supertest(server.getApp()).post('/dashboard/logout').set('Cookie',token!).expect(200);
 }finally{await server.stop();}
 server=router();try{await supertest(server.getApp()).get('/status').set('Cookie',token!).expect(401);}finally{await server.stop();}
});
test('unusable storage never issues a cookie or authenticates a forged session',async()=>{
 writeFileSync(join(root,'dashboard-sessions.db'),'invalid sqlite file');const server=router();
 try{
 const response=await supertest(server.getApp()).post('/dashboard/login').send({key:keys[0].key}).expect(503);
 expect(response.headers['set-cookie']).toBeUndefined();
 await supertest(server.getApp()).get('/status').set('Cookie','dash_session='+ 'a'.repeat(64)).expect(401);
 }finally{await server.stop();}
});
