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
