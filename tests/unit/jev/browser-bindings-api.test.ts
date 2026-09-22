import express from 'express';
import request from 'supertest';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {createBrowserBindingsRouter} from '../../../src/api/browser-bindings-router';
import * as connector from '../../../src/jev/browser-connector';
let root:string,config:any,runner:any,app:express.Express,path:string;
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'browser-api-'));path=join(root,'config.json');
 config={gateway:{api:{keys:[{id:'owner',key:'admin-fixture',admin:true,agents:'*'},{id:'other',key:'other-fixture',admin:true,agents:'*'},{id:'readonly',key:'reader-fixture',agents:'*'}]},jev:{enabled:true,provider:'typesafe',model:'jev',features:{browserTasks:{enabled:true}},browser:{adapterModule:'@example/runner',bindings:[]}}},agents:[{id:'a'}]};
 runner={getAgentConfig:()=>config.agents[0],browserSessionScope:async(s:string,p:string)=>{if(s!=='session'||p!=='api:owner')throw Error('ACCESS_DENIED');return {principalId:p,conversationId:'conversation'};}};
 writeFileSync(path,JSON.stringify(config));
 jest.spyOn(connector,'resolveBrowserConnection').mockReturnValue({endpoint:'https://browser.example/mcp',headers:{Authorization:'Bearer PRIVATE-TEST-SECRET'}});
 jest.spyOn(connector,'inspectBrowser').mockResolvedValue({observedAt:1,observation:{generation:'g',elements:[]}});
 app=express();app.use(express.json());app.use(createBrowserBindingsRouter(config,new Map([['a',runner]]),path));
});
afterEach(()=>{jest.restoreAllMocks();rmSync(root,{recursive:true,force:true});});
const url='/v1/agents/a/sessions/session/browser-bindings';
const body={name:'Approved tab',connectorId:'paired',scope:{device_id:'d',grant_id:'g',tab_id:'t'}};
test('bind/list/delete derive identity and persist only connector reference under config lock',async()=>{
 const created=await request(app).post(url).set('Authorization','Bearer admin-fixture').send(body);expect(created.status).toBe(201);
 const stored=JSON.parse(readFileSync(path,'utf8'));expect(stored.gateway.jev.browser.bindings[0]).toMatchObject({principalId:'api:owner',conversationId:'conversation',connectorId:'paired'});
 expect(JSON.stringify(stored)).not.toContain('PRIVATE-TEST-SECRET');expect(stored.gateway.jev.browser.bindings[0].endpoint).toBeUndefined();
 expect((await request(app).get(url).set('Authorization','Bearer admin-fixture')).body.bindings).toHaveLength(1);
 expect((await request(app).delete(url+'/'+created.body.binding.id).set('Authorization','Bearer other-fixture')).status).toBe(403);
 expect((await request(app).delete(url+'/'+created.body.binding.id).set('Authorization','Bearer admin-fixture')).status).toBe(204);
 expect(config.gateway.jev.browser.bindings).toEqual([]);
});
test('rejects anonymous, foreign-session, non-admin and caller supplied identity',async()=>{
 expect((await request(app).post(url).send(body)).status).toBe(401);
 for(const token of ['other-fixture','reader-fixture'])expect((await request(app).post(url).set('Authorization','Bearer '+token).send(body)).status).toBe(403);
 expect((await request(app).post(url.replace('/session/','/foreign/')).set('Authorization','Bearer admin-fixture').send(body)).status).toBe(403);
 expect((await request(app).post(url).set('Authorization','Bearer admin-fixture').send({...body,principalId:'other'})).status).toBe(400);
 expect(connector.inspectBrowser).not.toHaveBeenCalled();
});
test('scope proof failure or API-key revocation during proof cannot persist a binding',async()=>{
 (connector.inspectBrowser as jest.Mock).mockRejectedValueOnce(Error('denied'));
 expect((await request(app).post(url).set('Authorization','Bearer admin-fixture').send(body)).status).toBe(403);
 (connector.inspectBrowser as jest.Mock).mockImplementationOnce(async()=>{config.gateway.api.keys=[];return {observedAt:1,observation:{}};});
 expect((await request(app).post(url).set('Authorization','Bearer admin-fixture').send(body)).status).toBe(403);
 expect(JSON.parse(readFileSync(path,'utf8')).gateway.jev.browser.bindings).toEqual([]);
});
