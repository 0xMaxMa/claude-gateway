import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getEncoding } from 'js-tiktoken';
import { AGENT_TASK_TOOLS } from './agent-tool-schemas';

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
/** Run in the dashboard reader thread. Never launch a CLI/model or return file content. */
export function contextFootprint(workspace: string | undefined, jevEnabled = false): ContextFootprint {
  if (!workspace) return {observedAt:Date.now(),rows:[]};
  const key=JSON.stringify([workspace,jevEnabled]), previous=cache.get(key);
  if(previous && Date.now()-previous.at<30000)return previous.value;
  const rows:ContextFootprint['rows']=[];
  const read=(name:string):string|undefined=>{
    try{const filename=join(workspace,name);if(statSync(filename).size>1024*1024)return undefined;return readFileSync(filename,'utf8');}catch{return undefined;}
  };
  const add=(name:string,text:string|undefined,note:string)=>rows.push({name,tokens:text===undefined?null:referenceTokens(text),characters:text===undefined?null:[...text].length,hasContent:Boolean(text?.trim()),note});
  const composed=read('CLAUDE.md');
  add('CLAUDE.md · composed workspace context',composed,'Current generated file after workspace budgets. Parent total; do not add its sections again. Not the complete CLI prompt.');
  const labels:Record<string,string>={'AGENT IDENTITY':'AGENTS.md','IDENTITY':'IDENTITY.md','SOUL':'SOUL.md','USER PROFILE':'USER.md','LONG-TERM MEMORY':'MEMORY.md','HEARTBEAT CONFIG':'HEARTBEAT.md','AVAILABLE SKILLS':'Skill catalog','MEMORY RULE':'Memory rules','MEMORY RETRIEVAL':'Memory retrieval instructions'};
  if(composed){
    const markers=[...composed.matchAll(/^--- ([A-Z -]+) ---\n/gm)];
    for(let i=0;i<markers.length;i++){
      const marker=markers[i],name=labels[marker[1]]||marker[1];
      const text=composed.slice(marker.index!+marker[0].length,markers[i+1]?.index??composed.length);
      add('↳ '+name,text,'Section found in generated CLAUDE.md; includes section whitespace. Boundary tokenization can differ from parent total.');
    }
  }
  for(const name of ['AGENTS.md','IDENTITY.md','SOUL.md','USER.md','MEMORY.md','HEARTBEAT.md'])add(name+' · source file',read(name),'Current file on disk before budget/index/truncation. Reference only; not added to composed context.');
  // Intake is invariant; optional Jev must match the currently permitted inventory.
  const tools = AGENT_TASK_TOOLS.filter(tool => tool.name !== 'jev_evaluate' || jevEnabled);
  add('Agent gateway tool schemas ('+tools.length+')',JSON.stringify(tools),'Current authorized host Agent MCP definitions: name, description and inputSchema. Excludes native CLI tools, worker tools and provider framing; existing processes may retain a preceding inventory.');
  const value={observedAt:Date.now(),rows};
  if(cache.size>=32)cache.delete(cache.keys().next().value!);
  cache.set(key,{at:Date.now(),value});return value;
}
