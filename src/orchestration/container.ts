import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { realpath, readFile, mkdir, writeFile, readdir, lstat } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { randomUUID, createHash } from 'crypto';
import { userInfo, homedir } from 'os';
import type { AgentConfig } from '../types';
import type { RuntimeProfile } from '../session/runtime-profile';
import { OrchestrationError } from './types';
// Resolve subprocess support only when this feature is invoked.
const exec = (file: string, args: string[], options: import('child_process').ExecFileOptions = {}) =>
  promisify(execFile)(file, args, { ...options, encoding: 'utf8' as const });

export function assertContainerBinding(agent: Pick<AgentConfig, 'type' | 'container'>, profile?: Pick<RuntimeProfile, 'containerExecution'>): void {
  if ((agent.type === 'app-agent' && !agent.container) || (profile?.containerExecution && agent.type !== 'app-agent')) throw new OrchestrationError('CONTAINER_REQUIRED', 'Host fallback is forbidden');
}

/** All executable operations go through docker exec; never retry on the host. */
export async function validateContainer(agent: AgentConfig): Promise<void> {
  if (!agent.container || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(agent.container)) throw new OrchestrationError('CONTAINER_REQUIRED');
  const { stdout } = await exec('docker', ['inspect', agent.container], { timeout: 10000 });
  await validateContainerInspection(agent, JSON.parse(stdout)[0]);
}

/** Shared by admission and the legacy-container migration preflight. */
export async function validateContainerInspection(agent: AgentConfig, c: any): Promise<void> {
  const h = c.HostConfig;
  if (!c.State?.Running || h.Privileged || (h.NetworkMode === 'host' || String(h.NetworkMode).startsWith('container:')) || h.PidMode || !['private','none',''].includes(h.IpcMode ?? '') || h.CapAdd?.length || !(h.CapDrop ?? []).includes('ALL') || !(h.SecurityOpt ?? []).some((s: string) => s.startsWith('no-new-privileges')) || h.Devices?.length) throw new OrchestrationError('CONTAINER_ISOLATION_REQUIRED');
  const workspace = await realpath(agent.workspace);
  const media = await realpath(join(agent.workspace, '..', 'media')).catch(() => join(agent.workspace, '..', 'media'));
  const ro = new Map<string, string>();
  for (const [destination, source] of [['/usr/local/bin/claude', '/usr/local/bin/claude'], ['/usr/bin/node', process.execPath], [join(dirname(dirname(process.execPath)), 'lib/node_modules'), join(dirname(dirname(process.execPath)), 'lib/node_modules')], [join(homedir(), '.claude-seed'), join(agent.workspace, '..', '.claude-seed')]]) {
    try { ro.set(destination, await realpath(source)); } catch { /* absent optional installer mount */ }
  }
  let workspaceFound = false;
  for (const m of c.Mounts ?? []) {
    if (/docker\.sock|containerd\.sock/.test(m.Source + m.Destination)) throw new OrchestrationError('CONTAINER_HOST_MOUNT_DENIED');
    const source = await realpath(m.Source);
    if (m.Destination === '/workspace' && source === workspace) { workspaceFound = true; continue; }
    // Existing app-agent installer mounts its own media, CLI/runtime and sanitized seed only.
    if (source === media && m.Destination === media) continue;
    const readOnlyAllowed = !m.RW && ro.get(m.Destination) === source;
    if (!readOnlyAllowed) throw new OrchestrationError('CONTAINER_HOST_MOUNT_DENIED');
  }
  if (!workspaceFound) throw new OrchestrationError('CONTAINER_WORKSPACE_REQUIRED');
}

export function containerNode(container: string, script: string, args: string[] = [], input = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['exec', '-i', '--workdir', '/workspace', '--user', String(userInfo().uid), container, 'node', '-e', script, ...args], { stdio: ['pipe','pipe','pipe'] });
    const chunks: Buffer[] = []; let size = 0; let error = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('Container operation timeout')); }, 15000);
    p.stdout.on('data', b => { size += b.length; if (size > 72 * 1024 * 1024) { p.kill(); reject(new Error('Container output too large')); } else chunks.push(b); });
    p.stderr.on('data', b => { if (error.length < 4096) error += b; });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error(`Container operation failed (${code}): ${error}`)); });
    p.stdin.on('error', () => {}); p.stdin.end(input);
  });
}

// A deliberately small MCP surface: no host module loader, shell endpoint or credentials.
const MCP_CLIENT = String.raw`
const fs=require('fs'),http=require('http'),readline=require('readline');
const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const reply=(id,result,error)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,...(error?{error}:{result})})+'\n');
readline.createInterface({input:process.stdin}).on('line',async line=>{let q;try{q=JSON.parse(line);if(q.id===undefined)return;
if(q.method==='initialize')return reply(q.id,{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'gateway',version:'1.0.0'}});
if(q.method==='ping')return reply(q.id,{});
if(q.method==='tools/list')return reply(q.id,{tools:c.tools});
if(q.method!=='tools/call'||!c.tools.some(t=>t.name===q.params.name))return reply(q.id,null,{code:-32601,message:'Tool unavailable'});
const body=JSON.stringify({tool:q.params.name,args:q.params.arguments||{},action_id:String(q.id)});
const request=http.request({socketPath:c.socket,path:'/call',method:'POST',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'}},r=>{let body='';r.on('data',b=>body+=b);r.on('end',()=>reply(q.id,{content:[{type:'text',text:body}],isError:r.statusCode!==200}));});
request.on('error',()=>reply(q.id,{content:[{type:'text',text:'Task bridge unavailable'}],isError:true}));request.setTimeout(20000,()=>request.destroy());request.end(body);
}catch(e){if(q?.id!==undefined)reply(q.id,null,{code:-32603,message:'Invalid MCP request'});}});
`;

export async function prepareContainerProfile(agent: AgentConfig, profile: RuntimeProfile): Promise<{ config: string; directory: string }> {
  await validateContainer(agent);
  const original = JSON.parse(await readFile(profile.mcpConfigPath, 'utf8')).mcpServers.gateway;
  const ticket = JSON.parse(await readFile(original.env.GATEWAY_ORCHESTRATION_TICKET_FILE, 'utf8'));
  if (!ticket.socket) throw new OrchestrationError('CONTAINER_BRIDGE_REQUIRED');
  const role = profile.role;
  // Schemas are data copied from the existing gateway MCP inventory, not executable host modules.
  const dir = '/tmp/gateway-orch-' + randomUUID();
  const payload = { role, socket: '/workspace/' + basename(ticket.socket), token: ticket.token, tools: ticket.tools };
  const config = { mcpServers: { gateway: { command: 'node', args: ['-e', MCP_CLIENT, dir + '/ticket.json'] } } };
  await containerNode(agent.container!, `const fs=require('fs');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const p=JSON.parse(s);fs.mkdirSync(p.dir,{mode:448});fs.writeFileSync(p.dir+'/ticket.json',JSON.stringify(p.ticket),{mode:384});fs.writeFileSync(p.dir+'/mcp.json',JSON.stringify(p.config),{mode:384});});`, [], JSON.stringify({ dir, ticket: payload, config }));
  if (profile.skillPluginDir) {
    const files: Record<string, string> = {}; let bytes = 0;
    const visit = async (base: string, rel = ''): Promise<void> => {
      for (const name of await readdir(base)) {
        const p = join(base, name), r = rel ? rel + '/' + name : name, stat = await lstat(p);
        if (stat.isSymbolicLink()) throw new OrchestrationError('SKILL_RESOURCE_SYMLINK_DENIED');
        if (stat.isDirectory()) await visit(p, r);
        else if (stat.isFile()) { bytes += stat.size; if (bytes > 10*1024*1024) throw new OrchestrationError('SKILL_RESOURCES_TOO_LARGE'); files[r] = (await readFile(p)).toString('base64'); }
      }
    };
    await visit(profile.skillPluginDir);
    await containerNode(agent.container!, `const fs=require('fs'),path=require('path');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{for(const [name,data] of Object.entries(JSON.parse(s))){const p=path.join(process.argv[1],name);fs.mkdirSync(path.dirname(p),{recursive:true,mode:448});fs.writeFileSync(p,Buffer.from(data,'base64'),{mode:384});}});`, [dir + '/skill-plugin'], JSON.stringify(files));
  }
  return { config: dir + '/mcp.json', directory: dir };
}

/** Read files INSIDE the container, then import bytes into a gateway-owned spool.
 * Never resolve an app-controlled symlink in the host namespace. */
export async function importContainerFile(agent: AgentConfig, spool: string, attempt: string, action: string, candidate: unknown): Promise<string> {
  if (typeof candidate !== 'string' || candidate.length > 4096) throw new OrchestrationError('ARTIFACT_PATH_DENIED');
  const data = await containerNode(agent.container!, `const fs=require('fs');const p=fs.realpathSync(process.argv[1]);if(!p.startsWith('/workspace/')&&!p.startsWith('/tmp/'))throw Error('ARTIFACT_PATH_DENIED');const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);if(!s.isFile()||s.size>50*1024*1024)throw Error('ARTIFACT_PATH_DENIED');const b=fs.readFileSync(fd);if(b.length>50*1024*1024)throw Error('ARTIFACT_PATH_DENIED');process.stdout.write(b.toString('base64'));`, [candidate]);
  const directory = join(spool, attempt); await mkdir(directory, { recursive: true, mode: 0o700 });
  const dest = join(directory, createHash('sha256').update(action).digest('hex').slice(0,16) + '-' + basename(candidate).replace(/[^a-zA-Z0-9._-]/g,'_').slice(-100));
  await writeFile(dest, Buffer.from(data, 'base64'), { mode: 0o600 }); return dest;
}

export const CONTAINER_SUPERVISOR = String.raw`
const fs=require('fs'),{spawn}=require('child_process');const [dir,bin,...args]=process.argv.slice(1);
const child=spawn(bin,args,{stdio:'inherit',detached:true,env:{...process.env,GATEWAY_CONTAINER_ATTEMPT:dir}});
child.on('error',()=>process.exit(1));
fs.writeFileSync(dir+'/process.json',JSON.stringify({pid:child.pid,start:fs.readFileSync('/proc/'+child.pid+'/stat','utf8').split(') ')[1].split(' ')[19]}));
child.on('exit',code=>process.exit(code||0));
`;
export async function stopContainerProfile(container: string, directory: string): Promise<boolean> {
  try {
    await containerNode(container, String.raw`const fs=require('fs');const d=process.argv[1];
if(!/^\/tmp\/gateway-orch-[a-f0-9-]+$/.test(d))throw Error('Invalid attempt');
let saved;try{saved=JSON.parse(fs.readFileSync(d+'/process.json','utf8'));}catch{throw Error('Process identity missing');}
const alive=()=>{try{return fs.readFileSync('/proc/'+saved.pid+'/stat','utf8').split(') ')[1].split(' ')[19]===saved.start;}catch{return false;}};
if(alive()){try{process.kill(-saved.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}
// Include detached descendants which retain the attempt marker (e.g. tool shells).
for(const p of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p))){try{if(fs.readFileSync('/proc/'+p+'/environ').toString().split('\0').includes('GATEWAY_CONTAINER_ATTEMPT='+d))process.kill(Number(p),'SIGKILL');}catch(e){if(!['ENOENT','ESRCH','EACCES'].includes(e.code))throw e;}}
setTimeout(()=>{if(alive()){const stat=fs.readFileSync('/proc/'+saved.pid+'/stat','utf8');if(stat.split(') ')[1][0]!=='Z')process.exit(1);}},100);
`, [directory]);
    return true;
  } catch { return false; }
}
