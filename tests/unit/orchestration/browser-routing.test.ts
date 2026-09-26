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
