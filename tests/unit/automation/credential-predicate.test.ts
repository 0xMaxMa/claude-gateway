import {credentialSupported,modelAuthHeaders,type ModelConnection} from '../../../src/automation/model-choice-evaluator';

const conn=(scheme:ModelConnection['scheme']):ModelConnection=>({baseUrl:'https://x.test',apiKey:'k',scheme});
const hosts=['https://api.anthropic.com/v1/messages','https://proxy.getpod.test/v1/messages'].map(u=>new URL(u));
test('modelAuthHeaders and the Thinking path share one credential predicate',()=>{
 for(const scheme of ['x-api-key','bearer','oauth'] as const)for(const url of hosts){
  let allowed=true;try{modelAuthHeaders(conn(scheme),url);}catch{allowed=false;}
  expect(credentialSupported(conn(scheme),url)).toBe(allowed);
 }
});
test('oauth to a proxy is sent exactly like bearer (no OAuth-specific header exists elsewhere in the gateway)',()=>{
 const url=hosts[1];expect(modelAuthHeaders(conn('oauth'),url)).toEqual(modelAuthHeaders(conn('bearer'),url));
});
