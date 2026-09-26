import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {resolveBrowserConnection} from './browser-connector';
import {resolveEnabledConnectors} from '../connectors/resolve';
import type {AgentConfig,GatewayConfig} from '../types';
import {createHash} from 'crypto';
import type {CommandContext} from '../orchestration/types';
export interface ComputerBinding {id:string;name:string;principalId:string;conversationId:string;connectorId:string;scope:{device_id:string;grant_id:string}}
export class ComputerConnectors {
 private rows:ComputerBinding[]=[];
 constructor(private config:GatewayConfig,private agent:AgentConfig){}
 connection(id:string){try{return resolveBrowserConnection(this.config,this.agent,id);}catch{throw Error('COMPUTER_CONNECTOR_UNAVAILABLE');}}
 private ids(){if(this.agent.allow_tools===false)return [];const entries=this.config.gateway.customConnectors??{},enabled=resolveEnabledConnectors(this.agent,entries,this.config.gateway.connectorsDefaultEnabled!==false);return Object.keys(enabled).filter(id=>(entries[id] as any)?.resourcesPath==='/v1/computer-grants');}
 get(id:string,principal:string,conversation:string){const found=this.rows.find(b=>b.id===id&&b.principalId===principal&&b.conversationId===conversation);if(!found||!this.ids().includes(found.connectorId))throw Error('COMPUTER_TARGET_UNAVAILABLE');this.connection(found.connectorId);return found;}
 async accessState(id:string,principal:string,conversation:string):Promise<{status:import('../orchestration/types').ComputerConnectionStatus;stoppedAt?:number}>{
  const binding=this.get(id,principal,conversation),connection=this.connection(binding.connectorId);
  const response=await fetch(new URL('/v1/computer-grants',connection.endpoint),{redirect:'error',headers:connection.headers,signal:AbortSignal.timeout(4000)});
  if(!response.ok)throw Error('COMPUTER_DISCOVERY_UNAVAILABLE');
  const text=await response.text();if(text.length>262144)throw Error('COMPUTER_DISCOVERY_INVALID');
  if(JSON.stringify(connection)!==JSON.stringify(this.connection(binding.connectorId)))throw Error('COMPUTER_CONNECTOR_CHANGED');
  const body=JSON.parse(text),grant=Array.isArray(body.grants)?body.grants.find((g:any)=>g.id===binding.scope.grant_id&&g.deviceId===binding.scope.device_id):undefined;
  return {status:!grant?'unknown':grant.online===false?'disconnected':grant.online!==true?'unknown':grant.ready===true?'connected':'waiting_access',...(Number.isSafeInteger(grant?.stoppedAt)&&grant.stoppedAt>0?{stoppedAt:grant.stoppedAt}:{})};
 }
 async stoppedAt(id:string,principal:string,conversation:string):Promise<number|undefined>{return (await this.accessState(id,principal,conversation)).stoppedAt;}
 async discover(context:Pick<CommandContext,'principalId'|'conversationId'>,authorized:()=>boolean){
  const found:ComputerBinding[]=[];const check=()=>{if(!authorized())throw Error('ACCESS_DENIED');};check();
  for(const id of this.ids().slice(0,10)){
   const connection=this.connection(id);const read=async()=>{const r=await fetch(new URL('/v1/computer-grants',connection.endpoint),{redirect:'error',headers:connection.headers,signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('COMPUTER_DISCOVERY_UNAVAILABLE');const text=await r.text();if(text.length>262144)throw Error('COMPUTER_DISCOVERY_INVALID');const body=JSON.parse(text);if(!Array.isArray(body.grants))throw Error('COMPUTER_DISCOVERY_INVALID');return body.grants;};
   let grants=await read();check();
   check();if(JSON.stringify(connection)!==JSON.stringify(this.connection(id)))throw Error('COMPUTER_CONNECTOR_CHANGED');
   for(const g of grants){if((g.expiresAt!==undefined&&g.expiresAt!==0&&(!Number.isFinite(g.expiresAt)||g.expiresAt<=Date.now()))||g.online!==true)continue;if(!/^[0-9a-f-]{36}$/i.test(g.id)||!/^[0-9a-f-]{36}$/i.test(g.deviceId))continue;
    const scope={device_id:g.deviceId,grant_id:g.id};found.push({id:'computer-'+createHash('sha256').update(JSON.stringify([this.agent.id,context.principalId,context.conversationId,id,scope])).digest('hex'),name:'Computer Use · '+String(g.label??'Computer').slice(0,80),principalId:context.principalId,conversationId:context.conversationId,connectorId:id,scope});
   }
  }
  this.rows=[...this.rows.filter(b=>b.principalId!==context.principalId||b.conversationId!==context.conversationId),...found].slice(-100);return found;
 }
}
export async function withComputerConnection<T>(connection:{endpoint:string;headers:Record<string,string>},run:(client:Client)=>Promise<T>,signal?:AbortSignal):Promise<T>{
 const client=new Client({name:'gateway-computer-use',version:'1.0.0'});const endpoint=new URL(connection.endpoint);
 const transport=new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:connection.headers,redirect:'error'},fetch:((input:any,init:any)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(u.href!==endpoint.href)throw Error('COMPUTER_ENDPOINT_CHANGED');return fetch(input,{...init,redirect:'error'});}) as typeof fetch});
 try{await client.connect(transport,{signal,timeout:10000});return await run(client);}finally{await client.close();}
}
