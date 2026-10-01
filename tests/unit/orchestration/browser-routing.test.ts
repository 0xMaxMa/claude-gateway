import { browserRouting, remoteBrowserIds } from '../../../src/orchestration/browser-routing';
import type { AgentConfig, GatewayConfig } from '../../../src/types';
jest.mock('../../../src/connectors/resolve',()=>({resolveEnabledConnectors:jest.fn(()=>({'getpod-remote-browser':{headers:{Authorization:'secret'}}}))}));
test('remote browser discovery uses enabled IDs and known source, never arbitrary labels or secrets',()=>{
 expect(remoteBrowserIds({'custom-id':{sourceUrl:'https://github.com/Crown-Labs/getpod-remote-browser'},disabled:{sourceUrl:'https://github.com/Crown-Labs/getpod-remote-browser'}},{'custom-id':{},github:{}})).toEqual(['custom-id']);
 const text=browserRouting({id:'a'} as AgentConfig,{gateway:{customConnectors:{}}} as GatewayConfig);
 expect(text).toContain('ask a short choice BEFORE dispatch');
 expect(text).toContain('getpod-remote-browser');
 expect(text).not.toContain('Authorization');expect(text).not.toContain('secret');
 expect(text).toContain('never replace Remote Browser');
});
test('container/isolated workers do not inherit host remote connector availability',()=>{
 const gateway={gateway:{customConnectors:{}}} as GatewayConfig;
 expect(browserRouting({id:'a',type:'app-agent'} as AgentConfig,gateway)).toContain('IDs for this agent: []');
 expect(browserRouting({id:'a'} as AgentConfig,gateway,false)).toContain('With no enabled Remote Browser');
});
test('enabled Jev defaults to scoped managed discovery and never direct-worker fallback',()=>{
 const gateway={gateway:{customConnectors:{},jev:{enabled:true,features:{browserTasks:{enabled:true}},browser:{bindings:[]}}}} as unknown as GatewayConfig;
 const text=browserRouting({id:'a'} as AgentConfig,gateway);
 expect(text).toContain('scope="browser"');expect(text).toContain('target_profile="gateway-managed"');expect(text).toContain('do not silently fall back');
 gateway.gateway.jev!.enabled=false;expect(browserRouting({id:'a'} as AgentConfig,gateway)).not.toContain('Remote Browser execution default');
});
// Live E2E (task e6149724): with a Mac task open, a step list that named no
// environment went to Computer Use although the user meant the shared Chrome tab.
test('with Computer Use also available, an unnamed browser request asks which one instead of following an open task',()=>{
 const gateway={gateway:{customConnectors:{}}} as GatewayConfig;
 const text=browserRouting({id:'a'} as AgentConfig,gateway,true,true);
 expect(text).toContain('Remote Browser on your Chrome tab, or Computer Use on your Mac?');
 expect(text).toContain('An open task does not by itself select its environment');
 expect(browserRouting({id:'a'} as AgentConfig,gateway,true,false)).not.toContain('Computer Use on your Mac?');
 expect(browserRouting({id:'a',type:'app-agent'} as AgentConfig,gateway,true,true)).not.toContain('Computer Use on your Mac?');
});
