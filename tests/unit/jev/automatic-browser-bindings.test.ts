import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AutomaticBrowserBindings } from '../../../src/jev/automatic-browser-bindings';
import { resolveBrowserConnection } from '../../../src/jev/browser-connector';
jest.mock('../../../src/connectors/resolve',()=>({resolveEnabledConnectors:()=>({'getpod-remote-browser':{}})}));
jest.mock('../../../src/jev/browser-connector',()=>({...jest.requireActual('../../../src/jev/browser-connector'),resolveBrowserConnection:jest.fn(()=>({endpoint:'https://browser.example/mcp',headers:{Authorization:'Bearer secret'}}))}));
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'auto-browser-'));jest.mocked(resolveBrowserConnection).mockClear();});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
const config=()=>({gateway:{customConnectors:{},jev:{browser:{bindings:[]}}}} as any);
const grant={id:'g',deviceId:'d',online:true,ready:true,policy:{control:true,tabs:[{id:'t',title:'Test'}]}};
const reply=(grants:unknown[])=>new Response(JSON.stringify({grants}));
test('approved tabs are scoped to identity, stable after restart and contain no secrets',async()=>{
 const cfg=config(),file=join(dir,'bindings.json'),fetcher=jest.fn().mockResolvedValue(reply([grant]));
 const a=new AutomaticBrowserBindings(cfg,{id:'a'} as any,file,fetcher);
 await a.refresh('p','c');const first=a.config()!.bindings[0];expect(first).toMatchObject({principalId:'p',conversationId:'c',scope:{device_id:'d',grant_id:'g',tab_id:'t'}});
 expect(readFileSync(file,'utf8')).not.toContain('secret');
 expect(new AutomaticBrowserBindings(cfg,{id:'a'} as any,file).config()!.bindings[0]).toEqual(first);
 fetcher.mockResolvedValue(reply([grant]));await a.refresh('other','c');expect(a.config()!.bindings).toHaveLength(2);expect(a.config()!.bindings[1].id).not.toBe(first.id);
 fetcher.mockResolvedValue(reply([]));await a.refresh('p','c');expect(a.config()!.bindings.map(x=>x.principalId)).toEqual(['other']);
});
test('offline, revoked, unapproved, expired and read-only grants are not bound',async()=>{
 const fetcher=jest.fn().mockResolvedValue(reply([{...grant,ready:false},{...grant,online:false},{...grant,expiresAt:1},{...grant,policy:{...grant.policy,control:false}}]));
 const a=new AutomaticBrowserBindings(config(),{id:'a'} as any,join(dir,'b'),fetcher);await a.refresh('p','c');expect(a.config()!.bindings).toEqual([]);
});
test('credential change during discovery prevents publication',async()=>{
 jest.mocked(resolveBrowserConnection).mockReturnValueOnce({endpoint:'https://browser.example/mcp',headers:{Authorization:'old'}}).mockReturnValueOnce({endpoint:'https://browser.example/mcp',headers:{Authorization:'new'}});
 const a=new AutomaticBrowserBindings(config(),{id:'a'} as any,join(dir,'b'),jest.fn().mockResolvedValue(reply([grant])));await expect(a.refresh('p','c')).rejects.toThrow('BROWSER_CONNECTOR_CHANGED');expect(a.config()!.bindings).toEqual([]);
});
test('browser-specific reasoning config takes precedence over shared Thinking config',()=>{
 const cfg=config();cfg.gateway.jev.browser.textHelper={baseUrl:'https://legacy.example/v1',model:'old',apiKeyEnv:'OLD_TEXT'};
 const a=new AutomaticBrowserBindings(cfg,{id:'a'} as any,join(dir,'b'));
 expect(a.config()!.textHelper!.model).toBe('old');
 cfg.gateway.jev.thinking={baseUrl:'https://models.example/v1',model:'small',apiKeyEnv:'THINKING_KEY'};
 expect(a.config()!.textHelper!.model).toBe('old');
 cfg.gateway.jev.thinking.model='new';expect(a.config()!.textHelper!.model).toBe('old');
 delete cfg.gateway.jev.browser.textHelper;expect(a.config()!.textHelper!.model).toBe('new');
});
