import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { homedir, userInfo } from 'os';
import { readFileSync } from 'fs';
import { join } from 'path';
import { gatewayCapacity } from './capacity';
import { AgentConfig, GatewayConfig } from '../types';
import { pathWithNativeBin, resolveClaudeBin } from '../session/claude-bin';
import { resolveOrchestrationConfig } from './config';
import { validateContainer } from './container';

export interface CliSkill { name: string; description: string; argumentHint?: string; aliases?: string[]; }
const validName = (value: unknown): value is string => typeof value === 'string' && /^[\w:.-]{1,128}$/.test(value);
export function parseCliSkills(value: unknown): CliSkill[] {
  if (!Array.isArray(value)) throw new Error('CLI_SKILL_DISCOVERY_INVALID');
  return value.slice(0, 1000).filter(c => c && validName(c.name) && typeof c.description === 'string').map(c => ({
    name: c.name, description: c.description.slice(0, 4096), argumentHint: typeof c.argumentHint === 'string' ? c.argumentHint.slice(0,512) : '',
    aliases: Array.isArray(c.aliases) ? c.aliases.filter(validName).slice(0,16) : [],
  }));
}

/** Initialization only: no user prompt, model call, MCP server or hooks. */
export function probeCliSkills(command: string, args: string[], cwd: string): Promise<CliSkill[]> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const child = spawn(command, args, {cwd, env: {...process.env, ...(pathWithNativeBin() ? {PATH:pathWithNativeBin()} : {})}, stdio:['pipe','pipe','pipe']});
    let buffer = '', bytes = 0, result: CliSkill[] | undefined, failure: Error | undefined, finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error?: Error) => {
      if (finished) return; finished = true; failure = error; clearTimeout(timer);
      child.stdin.end(); child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref();
    };
    const timer = setTimeout(() => stop(new Error('CLI_SKILL_DISCOVERY_TIMEOUT')), 10000);
    child.on('error', () => {clearTimeout(timer);if(killTimer)clearTimeout(killTimer);reject(new Error('CLI_SKILL_DISCOVERY_UNAVAILABLE'));});
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {}); // Diagnostics may contain account/config information.
    child.stdout.on('data', chunk => {
      bytes += chunk.length; if(bytes > 2*1024*1024){stop(new Error('CLI_SKILL_DISCOVERY_TOO_LARGE'));return;}
      buffer += chunk.toString();
      let newline: number;
      while ((newline=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        try {
          const message=JSON.parse(line);
          if(message.type!=='control_response' || message.response?.request_id!==id)continue;
          if(message.response.subtype!=='success') {stop(new Error('CLI_SKILL_DISCOVERY_UNAVAILABLE'));return;}
          result=parseCliSkills(message.response.response?.commands);stop();return;
        } catch {stop(new Error('CLI_SKILL_DISCOVERY_INVALID'));return;}
      }
    });
    child.on('close', () => {clearTimeout(timer);if(killTimer)clearTimeout(killTimer);if(result && !failure)resolve(result);else reject(failure ?? new Error('CLI_SKILL_DISCOVERY_UNAVAILABLE'));});
    child.stdin.write(JSON.stringify({type:'control_request',request_id:id,request:{subtype:'initialize'}})+'\n');
  });
}

const cache = new Map<string,{until:number;value:Promise<CliSkill[]>}>();
let discoveryTail: Promise<unknown> = Promise.resolve();
export function discoverCliSkills(agent: AgentConfig, cwd = agent.orchestration?.tasks?.projectRoot || agent.workspace, gateway?: GatewayConfig): Promise<CliSkill[]> {
  const container = agent.type === 'app-agent';
  const host = !container && resolveOrchestrationConfig(agent.orchestration).tasks.workspaceMode === 'host';
  const binary = container ? agent.claudeBin ?? 'claude' : process.env.CLAUDE_BIN || resolveClaudeBin().bin;
  const settings: {disableAllHooks:boolean;enabledPlugins?:Record<string,boolean>} = {disableAllHooks:true};
  if(!host && !container) {
    let enabled: Record<string,boolean> = {};
    try {enabled=JSON.parse(readFileSync(join(homedir(),'.claude','settings.json'),'utf8')).enabledPlugins ?? {};} catch { /* Profile validation remains authoritative at worker startup. */ }
    settings.enabledPlugins=Object.fromEntries(Object.keys(enabled).map(k=>[k,false]));
  }
  const args=['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
    '--setting-sources',container?'':host?'user,project,local':'user','--settings',JSON.stringify(settings),'--tools',host?'default':'Read,Glob,Grep,Bash,Edit,Write,Skill'];
  const key=JSON.stringify({binary,cwd,container:agent.container,host,settings});
  const old=cache.get(key);if(old && old.until>Date.now())return old.value;
  const value=discoveryTail.catch(()=>{}).then(async()=>{
    const release = gateway ? gatewayCapacity(gateway).acquire('agent') : undefined;
    if (gateway && !release) throw new Error('CLI_SKILL_DISCOVERY_CAPACITY');
    try {
    if(container){
      await validateContainer(agent); // Never probe host CLI as fallback for an app.
      let uid=1000;try{uid=userInfo().uid;}catch{/* match runtime fallback */}
      return await probeCliSkills('docker',['exec','--workdir','/workspace','--user',String(uid),'-e',`HOME=${homedir()}`,'-i',agent.container!,binary,...args],agent.workspace);
    }
    const [executable,...prefix]=binary.split(' ');
    return await probeCliSkills(executable,[...prefix,...args],cwd);
    } finally { release?.(); }
  });
  discoveryTail=value.then(()=>{},()=>{});
  cache.set(key,{until:Date.now()+30000,value});
  void value.catch(()=>{cache.delete(key);});
  return value;
}
