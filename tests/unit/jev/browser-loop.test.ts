import {BrowserConnectorRegistry,validateBrowserIntegration} from '../../../src/jev/browser-connector';
import {BrowserIntegrationConfig} from '../../../src/jev/browser-contract';
import {sanitizeJevChildEnv} from '../../../src/jev/child-env';
const config=():BrowserIntegrationConfig=>({adapterModule:'@example/browser-adapter',bindings:[{id:'tab',name:'Private browser',agentId:'alpha',principalId:'owner',conversationId:'chat',endpoint:'https://browser.example/mcp',apiKeyEnv:'PRIVATE_BROWSER_TOKEN',scope:{device_id:'device',grant_id:'grant',tab_id:'tab'}}]});
test('supports installed package exports or absolute module paths, not remote code',()=>{
 expect(()=>validateBrowserIntegration(config())).not.toThrow();
 for(const adapterModule of ['https://bad.example/code.js','../untrusted.js','a/b','@example/pkg/subpath'])expect(()=>validateBrowserIntegration({...config(),adapterModule})).toThrow();
 expect(()=>validateBrowserIntegration({...config(),adapterModule:'/opt/runner/index.mjs'})).not.toThrow();
});
test('rejects insecure destinations, ambiguous credentials, wildcard scopes and unbounded input',()=>{
 for(const endpoint of ['http://public.example/mcp','https://user:key@browser.example/mcp','https://browser.example/mcp?token=secret']){const c=config();c.bindings[0].endpoint=endpoint;expect(()=>validateBrowserIntegration(c)).toThrow();}
 for(const patch of [{apiKeyEnv:'ANTHROPIC_API_KEY'},{apiKeyFile:'/secret'},{budget:{timeoutMs:0}},{scope:{device_id:'d',grant_id:'g'}}]){const c=config();Object.assign(c.bindings[0],patch);expect(()=>validateBrowserIntegration(c)).toThrow();}
});
test('bindings are isolated by agent and retain stable identity until config changes',()=>{
 let c:BrowserIntegrationConfig|undefined=config();const r=new BrowserConnectorRegistry(()=>c,'alpha');
 const first=r.bindings()[0];expect(r.bindings()[0]).toBe(first);expect(new BrowserConnectorRegistry(()=>c,'beta').bindings()).toEqual([]);
 c=structuredClone(c!);c.bindings[0].scope.grant_id='replacement';expect(r.bindings()[0]).not.toBe(first);
 c=undefined;expect(r.bindings()).toEqual([]);
});
test('browser credentials are removed from child environments, including after config removal',()=>{
 const c=config();const env={PRIVATE_BROWSER_TOKEN:'secret',OPENAI_API_KEY:'native'};
 expect(sanitizeJevChildEnv(env,{browser:c})).toEqual({OPENAI_API_KEY:'native'});
 expect(sanitizeJevChildEnv(env)).toEqual({OPENAI_API_KEY:'native'});
});
test('connector references cannot override endpoints or credentials and rotation fences bindings',()=>{
 const c=config();const b=c.bindings[0];delete b.endpoint;delete b.apiKeyEnv;b.connectorId='paired';
 expect(()=>validateBrowserIntegration(c)).not.toThrow();
 expect(()=>validateBrowserIntegration({...c,bindings:[{...b,endpoint:'https://other.example/mcp'}]})).toThrow();
 let key='one',enabled=true;
 const registry=new BrowserConnectorRegistry(()=>c,'alpha',()=>{if(!enabled)throw Error('disconnected');return {endpoint:'https://browser.example/mcp',headers:{Authorization:key}};});
 const initial=registry.bindings()[0];expect(registry.bindings()[0]).toBe(initial);
 key='two';expect(registry.bindings()[0]).not.toBe(initial);
 enabled=false;expect(registry.bindings()).toEqual([]);
});
