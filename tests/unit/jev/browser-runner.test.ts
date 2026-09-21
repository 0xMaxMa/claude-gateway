import {BrowserConnectorRegistry,validateBrowserIntegration} from '../../../src/jev/browser-connector';
import {BrowserIntegrationConfig} from '../../../src/jev/browser-contract';
import {sanitizeJevChildEnv} from '../../../src/jev/child-env';
const config=():BrowserIntegrationConfig=>({runnerModule:'@example/browser-runner',bindings:[{id:'tab',name:'Private browser',agentId:'alpha',principalId:'owner',conversationId:'chat',endpoint:'https://browser.example/mcp',apiKeyEnv:'PRIVATE_BROWSER_TOKEN',scope:{device_id:'device',grant_id:'grant',tab_id:'tab'}}]});
test('supports installed package exports or absolute module paths, not remote code',()=>{
 expect(()=>validateBrowserIntegration(config())).not.toThrow();
 for(const runnerModule of ['https://bad.example/code.js','../untrusted.js','a/b','@example/pkg/subpath'])expect(()=>validateBrowserIntegration({...config(),runnerModule})).toThrow();
 expect(()=>validateBrowserIntegration({...config(),runnerModule:'/opt/runner/index.mjs'})).not.toThrow();
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
