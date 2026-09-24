import {requestBrowserConsent} from './browser-consent';
import { createLoopServer } from '@0xmaxma/jev-loop/mcp';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash, randomUUID } from 'node:crypto';
import { resolveEnabledConnectors } from '../connectors/resolve';
import type { AgentConfig, GatewayConfig } from '../types';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BrowserConnectorConfig, BrowserExecutionContext, BrowserExecutionResult, BrowserIntegrationConfig, BrowserLogicModule } from './browser-contract';
import type { BrowserTaskBinding } from '../orchestration/gateway-tasks/browser';
import { JevError } from './types';
import { isReservedJevCredentialEnv } from './child-env';

const invalid = (): never => { throw new JevError('INVALID_CONFIG', 'Invalid browser integration configuration.'); };
const object = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
export function validateBrowserIntegration(value: BrowserIntegrationConfig | undefined): void {
  if (value === undefined) return;
  if (!object(value) || Object.keys(value).some(k => !['bindings','textHelper'].includes(k)) || !Array.isArray(value.bindings) || value.bindings.length > 100) invalid();
  if(value.textHelper!==undefined){
    const h=value.textHelper;
    if(!object(h)||Object.keys(h).some(k=>!['api','baseUrl','model','apiKeyEnv','apiKeyFile'].includes(k))||!string(h.model)||Boolean(h.apiKeyEnv)===Boolean(h.apiKeyFile))invalid();
    if(h.api!==undefined&&!['openai-chat','anthropic-messages'].includes(h.api))invalid();
    validateEndpoint(h.baseUrl);
    if(h.apiKeyEnv!==undefined&&(!string(h.apiKeyEnv)||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(h.apiKeyEnv)||isReservedJevCredentialEnv(h.apiKeyEnv)))invalid();
    if(h.apiKeyFile!==undefined&&(!string(h.apiKeyFile,4096)||!isAbsolute(h.apiKeyFile)))invalid();
  }
  const ids = new Set<string>();
  for (const b of value.bindings) {
    if (!object(b) || Object.keys(b).some(k => !['id','name','agentId','principalId','conversationId','endpoint','apiKeyEnv','apiKeyFile','connectorId','scope','fields','budget'].includes(k)) || ![b.id,b.name,b.agentId,b.principalId,b.conversationId].every(v => string(v)) || ids.has(b.id)) invalid();
    ids.add(b.id);
    if (b.connectorId !== undefined) {
      if (!string(b.connectorId,128) || b.endpoint !== undefined || b.apiKeyEnv !== undefined || b.apiKeyFile !== undefined) invalid();
    } else {
      validateEndpoint(b.endpoint);
      if (Boolean(b.apiKeyEnv) === Boolean(b.apiKeyFile)) invalid();
      if (b.apiKeyEnv !== undefined && (!string(b.apiKeyEnv) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.apiKeyEnv) || isReservedJevCredentialEnv(b.apiKeyEnv))) invalid();
      if (b.apiKeyFile !== undefined && (!string(b.apiKeyFile,4096) || !isAbsolute(b.apiKeyFile))) invalid();
    }
    if (!object(b.scope) || Object.keys(b.scope).length !== 3 || !['device_id','grant_id','tab_id'].every(k => string((b.scope as any)[k],120))) invalid();
    if (b.fields !== undefined && (!Array.isArray(b.fields) || b.fields.length > 60 || b.fields.some(f => !object(f) || Object.keys(f).some(k => !['label','text'].includes(k)) || !string(f.label,250) || typeof f.text !== 'string' || f.text.length > 2000))) invalid();
    if (b.budget !== undefined) {
      const ranges: Record<string,[number,number]> = {maxSteps:[1,100],maxEvaluations:[1,150],timeoutMs:[1000,600000],maxTextCalls:[0,60],maxStaleRetries:[0,10],operationConfidence:[0,1],targetConfidence:[0,1]};
      if (!object(b.budget)) invalid();
      for (const [k,v] of Object.entries(b.budget)) if (!ranges[k] || typeof v !== 'number' || !Number.isFinite(v) || v < ranges[k][0] || v > ranges[k][1] || (!k.endsWith('Confidence') && !Number.isInteger(v))) invalid();
    }
  }
}

export function validateEndpoint(value: unknown): URL {
  if (!string(value,4096)) invalid();
  let url: URL; try { url = new URL(value as string); } catch { return invalid(); }
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(url.hostname)))) invalid();
  return url;
}
export interface BrowserConnection { endpoint: string; headers: Record<string,string> }
/** Existing connector enablement and secret store remain authoritative. Never persist resolved headers. */
export function resolveBrowserConnection(config: GatewayConfig, agent: AgentConfig, id: string): BrowserConnection {
  if (!Object.prototype.hasOwnProperty.call(config.gateway.customConnectors ?? {},id)) throw Error('BROWSER_CONNECTOR_UNAVAILABLE');
  const resolved = resolveEnabledConnectors(agent,config.gateway.customConnectors,config.gateway.connectorsDefaultEnabled !== false)[id] as {type?:string;url?:string;headers?:unknown}|undefined;
  if (!resolved || resolved.type !== 'http') throw Error('BROWSER_CONNECTOR_UNAVAILABLE');
  const endpoint=validateEndpoint(resolved.url).href;
  if (!object(resolved.headers) || Object.keys(resolved.headers).some(k=>k.toLowerCase()!=='authorization')) throw Error('BROWSER_CONNECTOR_AUTH_UNSUPPORTED');
  const entries=Object.entries(resolved.headers);
  if (entries.length!==1 || !string(entries[0][1],16384)) throw Error('BROWSER_CREDENTIAL_UNAVAILABLE');
  return {endpoint,headers:{Authorization:entries[0][1]}};
}

// Preserve native import for optional ESM packages when gateway is compiled as CJS.
const importModule = new Function('url', 'return import(url)') as (url: string) => Promise<BrowserLogicModule>;
const tools = new Set(['browser_task_acquire','browser_task_renew','browser_task_release','page_observe','page_click','page_type','page_select','page_scroll','tab_navigate']);
async function credential(binding: BrowserConnectorConfig): Promise<string> {
  let key: string;
  if (binding.apiKeyFile) {
    if ((await stat(binding.apiKeyFile)).size > 16384) throw Error('BROWSER_CREDENTIAL_INVALID');
    key = (await readFile(binding.apiKeyFile, 'utf8')).trim();
  } else key = process.env[binding.apiKeyEnv!] ?? '';
  if (!key || key.length > 16384 || /[\x00-\x20\x7f]/.test(key)) throw Error('BROWSER_CREDENTIAL_UNAVAILABLE');
  return key;
}
export async function executeBrowserModule(modulePath: string, binding: BrowserConnectorConfig, context: BrowserExecutionContext, connection?: BrowserConnection): Promise<BrowserExecutionResult> {
  const assertAccess = () => { if (!context.authorized()) throw Error('ACCESS_DENIED'); };
  assertAccess(); context.signal.throwIfAborted();
  const resolved = isAbsolute(modulePath) ? modulePath : createRequire(__filename).resolve(modulePath);
  const module = await importModule(pathToFileURL(resolved).href);
  if (module.BROWSER_USE_CONTRACT_VERSION !== 1 || typeof module.runBrowserUse !== 'function' || typeof module.mcpBrowserTransport !== 'function') throw Error('BROWSER_ADAPTER_INCOMPATIBLE');
  const key = connection ? undefined : await credential(binding);
  assertAccess(); context.signal.throwIfAborted();
  const client = new Client({name:'gateway-browser-task',version:'1.0.0'});
  const transport = browserTransport(connection ?? {endpoint:binding.endpoint!,headers:{Authorization:`Bearer ${key}`}});
  try {
    await client.connect(transport, {signal: context.signal, timeout:10000});
    if(context.requestConsent){
      const signal=context.interruptSignal ? AbortSignal.any([context.signal,context.interruptSignal]) : context.signal;
      const waiting=()=>context.progress({phase:'waiting_consent',steps:0,evaluations:0});
      waiting();
      let reason:string|undefined;
      try{reason=await requestBrowserConsent(client,binding.scope,signal,context.authorized,waiting);}
      catch(error){
        if(context.signal.aborted||context.interruptSignal?.aborted)return {status:'cancelled',reason:context.interruptSignal?.aborted?'REVISION_SUPERSEDED':'CANCELLED',steps:0,evaluations:0};
        throw error;
      }
      if(reason)return {status:'blocked',reason,steps:0,evaluations:0};
    }
    const call = module.mcpBrowserTransport(async (name,args,signal) => {
      // Release only the already-held lease even after config revocation; no other late call is allowed.
      if (name !== 'browser_task_release') assertAccess();
      if (!tools.has(name) || ['device_id','grant_id','tab_id'].some(k => args[k] !== binding.scope[k as keyof typeof binding.scope])) throw Error('BROWSER_SCOPE_DENIED');
      if (name === 'tab_navigate' || (name.startsWith('page_') && name !== 'page_observe')) {
        if(context.interruptSignal?.aborted)return {content:[{type:'text',text:JSON.stringify({error:'REVISION_SUPERSEDED',action_executed:false})}],isError:true};
        if (!context.beforeMutation || typeof args.operation_id !== 'string') throw Error('BROWSER_CHECKPOINT_UNAVAILABLE');
        context.signal.throwIfAborted();
        context.beforeMutation(args.operation_id, name);
        assertAccess(); context.signal.throwIfAborted();
      }
      const result = await client.callTool({name,arguments:args}, undefined, {signal,timeout:35000});
      return {content:result.content as unknown[],isError:result.isError as boolean | undefined};
    });
    let independentlyVerified = false;
    const result = await runThroughLoopMcp(context, loopSignal => module.runBrowserUse({contractVersion:1,goal:context.goal,...(context.startUrl?{startUrl:context.startUrl}:{}),scope:binding.scope,fields:[...(binding.fields??[]).filter(b=>!(context.fields??[]).some(f=>f.label.normalize("NFKC").trim().replace(/\s+/g," ")===b.label.normalize("NFKC").trim().replace(/\s+/g," "))),...(context.fields??[])],...binding.budget}, {
      call,
      trace:context.trace,
      interruptSignal:context.interruptSignal,
      evaluate: async(request,signal) => { assertAccess(); const response = await context.evaluate(request,signal); assertAccess(); return {model:response.model,answers:response.answers}; },
      progress: event => { assertAccess(); context.progress(event); },
      ...(module.verifyBrowserTask ? {verify:async(observation:unknown,signal:AbortSignal) => {assertAccess();const verified = await module.verifyBrowserTask!(context.goal,observation,signal);assertAccess();signal.throwIfAborted();independentlyVerified=validateBrowserVerification(verified);return independentlyVerified;}} : {}),
      // Missing field values return FIELD_TEXT_REQUIRED to the owning agent.
      // Do not inject an independent text model or a package-provided fallback.
    }, loopSignal));
    if (result.status === 'succeeded') {
      assertAccess();
      if (!independentlyVerified || context.signal.aborted) return {...result,status:'needs_verification',reason:'VERIFICATION_FAILED'};
    }
    return result;
  } finally { await client.close().catch(() => {}); }
}

/** Optional installed hooks are runtime values, even when their declarations promise boolean. */
export function validateBrowserVerification(value: unknown): boolean {
  if (typeof value !== 'boolean') throw Object.assign(new Error('Invalid browser verifier result.'), {code:'INVALID_CONTRACT'});
  return value;
}

function browserTransport(connection: BrowserConnection): StreamableHTTPClientTransport {
  const endpoint=validateEndpoint(connection.endpoint);
  return new StreamableHTTPClientTransport(endpoint, {
    requestInit:{headers:connection.headers,redirect:'error'},
    fetch:(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
      const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
      if(target.origin!==endpoint.origin || target.pathname!==endpoint.pathname || target.search!==endpoint.search)throw Error('BROWSER_ENDPOINT_CHANGED');
      return fetch(input,{...init,redirect:'error'});
    }) as typeof fetch,
  });
}
/** Read-only reconciliation. Operation IDs come from this task's durable receipt, never caller input. */
export async function inspectBrowser(binding: BrowserConnectorConfig, result: Partial<BrowserExecutionResult> | undefined, signal: AbortSignal, authorized:()=>boolean, connection?:BrowserConnection,screenshot=false): Promise<NonNullable<import('./browser-contract').BrowserEvidence['fresh']>> {
  const check=()=>{signal.throwIfAborted();if(!authorized())throw Error('ACCESS_DENIED');};
  check();
  const resolved=connection??{endpoint:binding.endpoint!,headers:{Authorization:`Bearer ${await credential(binding)}`}};
  check();
  const client=new Client({name:'gateway-browser-inspection',version:'1.0.0'});
  let lease:string|undefined;
  try {
    await client.connect(browserTransport(resolved),{signal,timeout:10000});
    const read=async(name:string,args:Record<string,unknown>)=>{
      check();const reply=await client.callTool({name,arguments:args},undefined,{signal,timeout:10000});check();
      if(reply.isError)throw Error('BROWSER_INSPECTION_FAILED');
      const text=(reply.content as Array<{type:string;text?:string}>).filter(c=>c.type==='text').map(c=>c.text??'').join('');
      if(Buffer.byteLength(text)>262144)throw Error('BROWSER_EVIDENCE_TOO_LARGE');
      try{return JSON.parse(text);}catch{throw Error('BROWSER_EVIDENCE_INVALID');}
    };
    // A leased read never reopens consent after Stop/revoke; acquire fails closed if another task owns the tab.
    const acquired=await read('browser_task_acquire',{...binding.scope,operation_id:randomUUID()});
    if(!object(acquired) || acquired.state!=='completed' || acquired.replayed || !object(acquired.result) || acquired.result.protocol_version!==1 || typeof acquired.result.lease_token!=='string' || !/^[0-9a-f-]{36}$/i.test(acquired.result.lease_token))throw Error('BROWSER_INSPECTION_DENIED');
    lease=acquired.result.lease_token;
    const observation=await read('page_observe',{...binding.scope,lease_token:lease,detail:'full'});
    if(!object(observation) || observation.error || observation.access || observation.protocol_version!==1 || !string(observation.generation,100) || typeof observation.url!=='string' || observation.url.length>8192 || typeof observation.text!=='string' || observation.text.length>24000 || !Array.isArray(observation.elements) || observation.elements.length>150 || observation.elements.some((e:unknown)=>!object(e)||typeof e.ref!=='string'||typeof e.label!=='string'))throw Error('BROWSER_EVIDENCE_INVALID');
    const operationStatus=result?.lastAction ? await read('operation_status',{operation_id:result.lastAction.operationId}) : undefined;
    let image: {type:'image';mimeType:'image/png';data:string}|undefined;
    if(screenshot){
      check();const reply=await client.callTool({name:'page_screenshot',arguments:{...binding.scope,lease_token:lease}},undefined,{signal,timeout:10000});check();
      const content=(reply.content as Array<{type:string;mimeType?:string;data?:string}>).find(c=>c.type==='image');
      if(reply.isError||!content||content.mimeType!=='image/png'||typeof content.data!=='string'||content.data.length>8*1024*1024||!/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(content.data))throw Error('BROWSER_EVIDENCE_INVALID');
      image={type:'image',mimeType:'image/png',data:content.data};
    }
    return {observedAt:Date.now(),observation,...(operationStatus ? {operationStatus}: {}),...(image?{screenshot:image}:{})};
  } finally {
    if(lease)await client.callTool({name:'browser_task_release',arguments:{...binding.scope,lease_token:lease,operation_id:randomUUID()}},undefined,{signal:AbortSignal.timeout(3000),timeout:3000}).catch(()=>{});
    await client.close().catch(()=>{});
  }
}

/** Stable binding objects allow live config replacement/revocation to fence active requests. */
export class BrowserConnectorRegistry {
  private cache = new Map<string,{signature:string;binding:BrowserTaskBinding}>();
  constructor(private readonly getConfig: () => BrowserIntegrationConfig | undefined, private readonly agentId: string, private readonly connection?: (id:string)=>BrowserConnection) {}
  bindings(): BrowserTaskBinding[] {
    const config = this.getConfig();
    validateBrowserIntegration(config);
    const current = new Map<string,{signature:string;binding:BrowserTaskBinding}>();
    for (const b of config?.bindings ?? []) {
      if (b.agentId !== this.agentId) continue;
      let resolved: BrowserConnection | undefined;
      try { if(b.connectorId) {if(!this.connection)continue;resolved=this.connection(b.connectorId);} } catch { continue; }
      const signature = createHash('sha256').update(JSON.stringify([b,resolved])).digest('hex');
      let item = this.cache.get(b.id);
      if (item?.signature !== signature) {
        const snapshot = structuredClone(b), modulePath = '@0xmaxma/jev-loop/browser-use';
        item = {signature,binding:{version:1,id:b.id,name:b.name,principalId:b.principalId,conversationId:b.conversationId,
          run:context => executeBrowserModule(modulePath,snapshot,context,resolved),
          inspect:(result,signal,authorized,screenshot)=>inspectBrowser(snapshot,result,signal,authorized,resolved,screenshot)}};
      }
      current.set(b.id,item);
    }
    this.cache = current;
    return [...current.values()].map(x=>x.binding);
  }
}

/** Host-local MCP keeps credential/checkpoint callbacks private while using the agent-facing protocol. */
async function runThroughLoopMcp(context: BrowserExecutionContext, run: (signal: AbortSignal) => Promise<BrowserExecutionResult>): Promise<BrowserExecutionResult> {
  const server = createLoopServer({
    signal: context.signal,
    authorize: () => context.authorized(),
    logics: [{id: 'browser', inputSchema: {type:'object',properties:{goal:{type:'string'}},required:['goal'],additionalProperties:false}, parse: input => {
      // This server belongs to exactly one already-authorized task, not a general browser endpoint.
      if (Object.keys(input).length !== 1 || input.goal !== context.goal) throw Error('BROWSER_SCOPE_DENIED');
      return input;
    }, run: async (_input, control) => { control.check(); return run(control.signal); }}],
  });
  const client = new Client({name:'gateway-jev-loop',version:'1.0.0'});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport, {signal:context.signal,timeout:10000});
    const response = await client.callTool({name:'jev_run',arguments:{logic:'browser',input:{goal:context.goal}}}, undefined, {signal:context.signal,timeout:610000});
    if (response.isError) throw Error('BROWSER_LOOP_INTERRUPTED_RECONCILE_REQUIRED');
    const content = response.content as Array<{type:string;text?:string}>;
    if (content.length !== 1 || content[0].type !== 'text' || !content[0].text) throw Error('BROWSER_LOOP_INVALID_RESULT');
    return JSON.parse(content[0].text) as BrowserExecutionResult;
  } finally { await client.close().catch(()=>{}); await server.close().catch(()=>{}); }
}
