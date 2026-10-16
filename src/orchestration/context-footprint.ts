import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getEncoding } from 'js-tiktoken';
import { AGENT_TASK_TOOLS } from './agent-tool-schemas';
import { composeTenantContext, tenantDirName, type MemoryBudgetConfig } from '../agent/workspace-loader';

const cache = new Map<string, {at:number; value:ContextFootprint}>();
let encoder: ReturnType<typeof getEncoding> | undefined;
export function referenceTokens(text: string): number {
  encoder ??= getEncoding('cl100k_base');
  return encoder.encode(text, [], []).length;
}
export interface ContextFootprint {
  observedAt: number;
  rows: Array<{name:string;tokens:number|null;characters:number|null;hasContent?:boolean;note:string}>;
}
/** Multi-tenant isolate mode (#601): the conversation whose memory is appended at spawn. */
export interface FootprintTenant { source: string; chatId: string; memoryBudget?: Partial<MemoryBudgetConfig> }
/** Run in the dashboard reader thread. Never launch a CLI/model or return file content. */
export function contextFootprint(workspace: string | undefined, jevEnabled = false, tenant?: FootprintTenant): ContextFootprint {
  if (!workspace) return {observedAt:Date.now(),rows:[]};
  const key=JSON.stringify([workspace,jevEnabled,tenant]), previous=cache.get(key);
  if(previous && Date.now()-previous.at<30000)return previous.value;
  const rows:ContextFootprint['rows']=[];
  const read=(name:string):string|undefined=>{
    try{const filename=join(workspace,name);if(statSync(filename).size>1024*1024)return undefined;return readFileSync(filename,'utf8');}catch{return undefined;}
  };
  const add=(name:string,text:string|undefined,note:string)=>rows.push({name,tokens:text===undefined?null:referenceTokens(text),characters:text===undefined?null:[...text].length,hasContent:Boolean(text?.trim()),note});
  const composed=read('CLAUDE.md');
  add('CLAUDE.md · composed workspace context',composed,'Current generated file after workspace budgets. Parent total; do not add its sections again. Not the complete CLI prompt.');
  const labels:Record<string,string>={'AGENT IDENTITY':'AGENTS.md','IDENTITY':'IDENTITY.md','SOUL':'SOUL.md','USER PROFILE':'USER.md','LONG-TERM MEMORY':'MEMORY.md','HEARTBEAT CONFIG':'HEARTBEAT.md','AVAILABLE SKILLS':'Skill catalog','MEMORY RULE':'Memory rules','MEMORY RETRIEVAL':'Memory retrieval instructions','TENANT CONTEXT':'Conversation memory paths'};
  const sections=(context:string,note:string)=>{
    const markers=[...context.matchAll(/^--- ([A-Z -]+) ---\n/gm)];
    for(let i=0;i<markers.length;i++){
      const marker=markers[i],name=labels[marker[1]]||marker[1];
      const text=context.slice(marker.index!+marker[0].length,markers[i+1]?.index??context.length);
      add('↳ '+name,text,note);
    }
  };
  if(composed)sections(composed,'Section found in generated CLAUDE.md; includes section whitespace. Boundary tokenization can differ from parent total.');
  // Isolate mode leaves sender files out of CLAUDE.md and appends this conversation's own at spawn.
  const tenantFiles=tenant&&join('tenants',tenantDirName(tenant.source,tenant.chatId));
  // Same 1 MiB guard as read(): composeTenantContext reads the files whole.
  const oversized=(name:string)=>{try{return statSync(join(workspace,tenantFiles!,name)).size>1024*1024;}catch{return false;}};
  if(tenant&&(oversized('USER.md')||oversized('MEMORY.md')))add('↳ Conversation memory',undefined,'A conversation memory file is larger than 1 MiB, so it was not measured.');
  else if(tenant)sections(composeTenantContext(workspace,tenant.source,tenant.chatId,tenant.memoryBudget),'This conversation\'s memory, appended at spawn after its budgets (multi-tenant isolate mode).');
  for(const name of ['AGENTS.md','IDENTITY.md','SOUL.md','USER.md','MEMORY.md','HEARTBEAT.md']){
    const own=tenantFiles&&(name==='USER.md'||name==='MEMORY.md');
    add(name+' · source file',read(own?join(tenantFiles,name):name),own?'This conversation\'s file under '+tenantFiles+' before budget/truncation. The workspace-root file is not composed in multi-tenant isolate mode.':'Current file on disk before budget/index/truncation. Reference only; not added to composed context.');
  }
  // Intake is invariant; optional Jev must match the currently permitted inventory.
  const tools = AGENT_TASK_TOOLS.filter(tool => tool.name !== 'jev_evaluate' || jevEnabled);
  add('Agent gateway tool schemas ('+tools.length+')',JSON.stringify(tools),'Current authorized host Agent MCP definitions: name, description and inputSchema. Excludes native CLI tools, worker tools and provider framing; existing processes may retain a preceding inventory.');
  const value={observedAt:Date.now(),rows};
  if(cache.size>=32)cache.delete(cache.keys().next().value!);
  cache.set(key,{at:Date.now(),value});return value;
}
