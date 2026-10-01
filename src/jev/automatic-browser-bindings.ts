import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { AgentConfig, GatewayConfig } from '../types';
import type { BrowserConnectorConfig, BrowserIntegrationConfig } from './browser-contract';
import { resolveBrowserConnection, validateBrowserIntegration } from './browser-connector';
import { resolveEnabledConnectors } from '../connectors/resolve';
import { remoteBrowserIds } from '../orchestration/browser-routing';
import { readRelayGrants } from './relay-grants';

/** Discover only relay-approved tabs. Persist identity-bound targets, never credentials. */
export class AutomaticBrowserBindings {
  private rows:BrowserConnectorConfig[]=[];
  private consentRequested=new Map<string,number>();
  constructor(private gateway:GatewayConfig,private agent:AgentConfig,private path:string,private request:typeof fetch=fetch) {
    try {
      const rows=JSON.parse(readFileSync(path,'utf8'));
      validateBrowserIntegration({bindings:rows});
      this.rows=rows.filter((b:BrowserConnectorConfig)=>b.agentId===agent.id && b.connectorId);
    } catch { /* Missing/invalid local cache is rediscovered, never trusted. */ }
  }
  config():BrowserIntegrationConfig|undefined {
    const config=this.gateway.gateway.jev?.browser;
    if(!config)return undefined;
    const manual=new Set(config.bindings.map(b=>b.id));
    return {...config,textHelper:config.textHelper??this.gateway.gateway.jev?.thinking,bindings:[...config.bindings,...this.rows.filter(b=>!manual.has(b.id))].slice(0,100)};
  }
  async refresh(principalId:string,conversationId:string,allowConsent=false,authorized:()=>boolean=()=>true,signal?:AbortSignal):Promise<void> {
    const check=()=>{if(!authorized())throw Error('ACCESS_DENIED');};check();
    if(this.agent.type==='app-agent'||this.agent.allow_tools===false)return;
    const entries=this.gateway.gateway.customConnectors??{};
    const ids=remoteBrowserIds(entries,resolveEnabledConnectors(this.agent,entries,this.gateway.gateway.connectorsDefaultEnabled!==false));
    const discovered:BrowserConnectorConfig[]=[];
    let prompted=false;
    for(const id of ids.slice(0,10)) {
      const connection=resolveBrowserConnection(this.gateway,this.agent,id);
      // This protocol uses the authenticated connector's origin, never a model-supplied URL.
      const response=await this.request(new URL('/v1/grants',connection.endpoint),{headers:connection.headers,redirect:'error',signal:bounded(10000,signal)});
      if(!response.ok)throw Error('BROWSER_DISCOVERY_UNAVAILABLE');
      let grants=await readRelayGrants(response,'BROWSER_DISCOVERY_INVALID');
      check();
      const pending=grants.filter((g:any)=>g?.online===true&&g.ready===false);
      if(allowConsent&&!prompted&&pending.length===1) {
        const grant=pending[0],key=JSON.stringify([principalId,conversationId,id,grant.id]);
        if(Date.now()-(this.consentRequested.get(key)??0)>60000) {
          prompted=true;this.consentRequested.set(key,Date.now());
          const client=new Client({name:'gateway-browser-consent',version:'1.0.0'});
          try {
            await client.connect(new StreamableHTTPClientTransport(new URL(connection.endpoint),{requestInit:{headers:connection.headers,redirect:'error'}}),{timeout:10000,...(signal?{signal}:{})});
            check();
            if(JSON.stringify(resolveBrowserConnection(this.gateway,this.agent,id))!==JSON.stringify(connection))throw Error('BROWSER_CONNECTOR_CHANGED');
            await client.callTool({name:'browser_request_access',arguments:{device_id:grant.deviceId,grant_id:grant.id,wait_ms:15000}},undefined,{timeout:20000,...(signal?{signal}:{})});
          } finally {await client.close();}
          const fresh=await this.request(new URL('/v1/grants',connection.endpoint),{headers:connection.headers,redirect:'error',signal:bounded(10000,signal)});
          if(!fresh.ok)throw Error('BROWSER_DISCOVERY_UNAVAILABLE');
          grants=await readRelayGrants(fresh,'BROWSER_DISCOVERY_INVALID');
        }
      }
      // Re-read enablement and credentials after network I/O, so revocation fences publication.
      if(JSON.stringify(resolveBrowserConnection(this.gateway,this.agent,id))!==JSON.stringify(connection))throw Error('BROWSER_CONNECTOR_CHANGED');
      let skipped=0;
      for(const grant of grants) {
        if(grant?.online!==true||grant.ready!==true||grant.policy?.control!==true||!Array.isArray(grant.policy.tabs))continue;
        if(grant.expiresAt && (!Number.isFinite(grant.expiresAt)||grant.expiresAt<=Date.now()))continue;
        for(const tab of grant.policy.tabs) {
          const scope={device_id:grant.deviceId,grant_id:grant.id,tab_id:tab?.id};
          const binding:BrowserConnectorConfig={id:'auto-'+createHash('sha256').update(JSON.stringify([this.agent.id,principalId,conversationId,id,scope])).digest('hex'),name:`Remote Browser · ${String(grant.label??'Browser').slice(0,80)} · ${String(tab?.title??'Tab').slice(0,80)}`,agentId:this.agent.id,principalId,conversationId,connectorId:id,scope};
          // One malformed relay entry must not hide every other approved tab.
          try{validateBrowserIntegration({bindings:[binding]});}catch{skipped++;continue;}
          discovered.push(binding);
        }
      }
      if(skipped)console.warn(JSON.stringify({ts:new Date().toISOString(),level:'warn',event:'Remote Browser discovery skipped malformed tabs',agentId:this.agent.id,connectorId:id,skipped}));
    }
    check();
    const rows=[...this.rows.filter(b=>b.principalId!==principalId||b.conversationId!==conversationId),...discovered];
    if(rows.length+(this.gateway.gateway.jev?.browser?.bindings.length??0)>100)throw Error('BROWSER_BINDING_LIMIT');
    const temp=this.path+'.'+randomUUID()+'.tmp';
    writeFileSync(temp,JSON.stringify(rows),{mode:0o600});renameSync(temp,this.path);this.rows=rows;
  }
}
/** A request deadline that also ends when the owning adapter shuts down. */
const bounded=(ms:number,signal?:AbortSignal)=>signal?AbortSignal.any([signal,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms);
