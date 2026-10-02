import {requestBrowserConsent} from '../../../src/jev/browser-consent';
const scope={device_id:'d',grant_id:'g',tab_id:'t'};
const reply=(state:string)=>({content:[{type:'text',text:JSON.stringify({state})}]});
test.each(['approved','denied','stopped'])('explicit consent handles %s without repeating a rejection',async state=>{
 const client:any={listTools:jest.fn(async()=>({tools:[{name:'browser_request_access'}]})),callTool:jest.fn(async()=>reply(state))};
 expect(await requestBrowserConsent(client,scope,new AbortController().signal,()=>true,()=>{})).toBe(state==='approved'?undefined:'BROWSER_CONSENT_DENIED');
 expect(client.callTool).toHaveBeenCalledTimes(1);
});
test('pending consent can be interrupted without another request',async()=>{
 const controller=new AbortController();const client:any={listTools:async()=>({tools:[{name:'browser_request_access'}]}),callTool:jest.fn(async()=>reply('pending'))};
 await expect(requestBrowserConsent(client,scope,controller.signal,()=>true,()=>controller.abort())).rejects.toBeDefined();
 expect(client.callTool).toHaveBeenCalledTimes(1);
});
test('revocation during consent never authorizes page work',async()=>{
 let allowed=true;const client:any={listTools:async()=>({tools:[{name:'browser_request_access'}]}),callTool:async()=>{allowed=false;return reply('approved');}};
 await expect(requestBrowserConsent(client,scope,new AbortController().signal,()=>allowed,()=>{})).rejects.toThrow('ACCESS_DENIED');
});
test('unsupported optional consent tool is skipped',async()=>{
 const client:any={listTools:async()=>({tools:[]}),callTool:jest.fn()};
 await requestBrowserConsent(client,scope,new AbortController().signal,()=>true,()=>{});expect(client.callTool).not.toHaveBeenCalled();
});
