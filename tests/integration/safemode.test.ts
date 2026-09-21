import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
const exec = promisify(execFile);
const entry = path.resolve(__dirname, '../../dist/entry.js');

// Configuration/account probe without a thread or provider request.
const nativeProbe = `if(process.argv.includes('app-server')){
 require('readline').createInterface({input:process.stdin}).on('line',line=>{
  const q=JSON.parse(line);if(!q.id)return;
  const result=q.method==='config/read'?{config:{model_provider:'fixture',model_providers:{fixture:{env_key:'FIXTURE_NATIVE_KEY'}}}}:q.method==='account/read'?{account:null}:{};
  console.log(JSON.stringify({id:q.id,result}));
 });
}else`;

describe('safemode detached CLI worker', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let id: string;
  const nativeId = '11111111-1111-4111-8111-111111111111';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-integration-'));
    id = randomUUID();
    const dir = path.join(home,'.claude-gateway','safemode',id);
    fs.mkdirSync(path.join(dir,'workspace'),{recursive:true});
    const targetConfig = path.join(home,'target','config.json');
    fs.mkdirSync(path.dirname(targetConfig),{recursive:true});
    fs.writeFileSync(targetConfig,JSON.stringify({marker:'saved target',gateway:{}}));
    fs.writeFileSync(path.join(home,'.claude-gateway','config.json'),JSON.stringify({marker:'wrong default',gateway:{}}));
    fs.writeFileSync(path.join(dir,'session.json'),JSON.stringify({id,name:'investigation',cli:'claude',model:'inherit',createdAt:new Date().toISOString(),nativeSessionId:nativeId,configPath:targetConfig}));
    const fake = path.join(home,'native-cli');
    fs.writeFileSync(fake,`#!/usr/bin/env node\nconst args=process.argv.slice(2);\nif(!args.includes('--resume')||!args.includes('${nativeId}')||!args.includes('--restricted'))process.exit(3);\nconsole.log(JSON.stringify({type:'system',subtype:'init',session_id:'${nativeId}'}));\nconsole.log(JSON.stringify({type:'result',result:'fixture diagnostic completed'}));\n`,{mode:0o700});
    env = {...process.env,HOME:home,CLAUDE_BIN:fake};
    delete env.GATEWAY_CONFIG; delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  });
  afterEach(()=>fs.rmSync(home,{recursive:true,force:true}));
  async function command(...args:string[]):Promise<any> {
    const {stdout}=await exec(process.execPath,[entry,'safemode',...args,'--json'],{env,timeout:10000}).catch(error => { error.message += '\n' + String(error.stdout) + String(error.stderr); throw error; });
    return JSON.parse(stdout);
  }
  test.each(['claude', 'codex'])('interactive %s params reach the native process, retain imported ID and cannot be imported twice', async cli => {
    const capture = path.join(home, 'captured.json');
    const fake = path.join(home, 'native-cli');
    fs.writeFileSync(fake, '#!/usr/bin/env node\n' + nativeProbe + '{require("fs").writeFileSync(process.env.HOME + "/captured.json", JSON.stringify(process.argv.slice(2)));require("fs").writeFileSync(process.env.HOME + "/credential-present", String(!!process.env.FIXTURE_NATIVE_KEY));}\n', {mode: 0o700});
    const importedId = '22222222-2222-4222-8222-222222222222';
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const permission = cli === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox';
    const resume = cli === 'claude' ? '--resume' : 'resume';
    env.CODEX_BIN = fake;
    env.FIXTURE_NATIVE_KEY = 'test-only-native-key';
    const cmd = [process.execPath, entry, 'safemode', '--cli', cli, '--name', 'imported',
      '--params', permission + ' ' + resume + ' ' + importedId].map(quote).join(' ');
    await exec('script', ['-q', '-e', '-c', cmd, '/dev/null'], {env, timeout: 15000}).catch(error => { error.message += '\n' + String(error.stdout) + String(error.stderr); throw error; });
    const args = JSON.parse(fs.readFileSync(capture, 'utf8'));
    expect(args.slice(0, 3)).toEqual([permission, resume, importedId]);
    expect(args).not.toContain('--permission-mode');
    if (cli === 'codex') expect(fs.readFileSync(path.join(home,'credential-present'),'utf8')).toBe('true');
    expect((await command('status', importedId)).id).toBe(importedId);
    await expect(exec('script', ['-q', '-e', '-c', cmd.replace("'imported'", "'duplicate'"), '/dev/null'], {env, timeout: 15000})).rejects.toThrow();
  });
  test.each(['claude','codex'])('%s no-bootstrap resume starts without an automatic prompt and retains explicit prompts', async cli => {
    const file=path.join(home,'.claude-gateway','safemode',id,'session.json');
    const record=JSON.parse(fs.readFileSync(file,'utf8'));record.cli=cli;fs.writeFileSync(file,JSON.stringify(record));
    const fake=path.join(home,'native-cli');env.CODEX_BIN=fake;
    fs.writeFileSync(fake,'#!/usr/bin/env node\n'+nativeProbe+'{require("fs").writeFileSync(process.env.HOME+"/captured.json",JSON.stringify(process.argv.slice(2)));}\n',{mode:0o700});
    const quote=(v:string)=>"'"+v.replace(/'/g,"'\\''")+"'";
    for(const prompt of [undefined,'Inspect latest state']) {
      const args=[process.execPath,entry,'safemode','--resume',nativeId,'--no-bootstrap','--params=--no-test-hook'];
      if(prompt)args.push('--prompt',prompt);
      await exec('script',['-q','-e','-c',args.map(quote).join(' '),'/dev/null'],{env,timeout:15000});
      const captured=JSON.parse(fs.readFileSync(path.join(home,'captured.json'),'utf8'));
      expect(captured).toContain(nativeId);
      if(cli==='codex')expect(captured[captured.indexOf('--cd')+1]).toBe(path.join(home,'.claude-gateway','safemode',prompt ? nativeId : id,'workspace'));
      expect(captured.join(' ')).not.toContain('You are investigating');
      expect(captured.includes('--')).toBe(!!prompt);
      if(prompt)expect(captured.at(-1)).toBe(prompt);
      expect(fs.existsSync(path.join(home,'.claude-gateway','safemode',nativeId,'workspace','diagnostics','provenance.json'))).toBe(true);
    }
  });
  test('fresh interactive Codex publishes its native ID while retaining the launch workspace', async () => {
    const native = '33333333-3333-4333-8333-333333333333';
    const fake = path.join(home, 'codex-fixture');
    fs.writeFileSync(fake, `#!/usr/bin/env node
${nativeProbe}{
const fs=require('fs'), path=require('path');
const now=new Date().toISOString();
const dir=path.join(process.env.HOME,'.codex','sessions',now.slice(0,10).replace(/-/g,'/'));
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'rollout.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'${native}',cwd:process.cwd(),timestamp:now,source:'cli'}})+'\\n');
setTimeout(()=>process.exit(0),1600);
}
`, {mode: 0o700});
    env.CODEX_BIN = fake;
    const cmd = [process.execPath, entry, 'safemode', '--cli', 'codex', '--params=--no-alt-screen'].map(v => "'" + v + "'").join(' ');
    await exec('script', ['-q', '-e', '-c', cmd, '/dev/null'], {env, timeout:15000}).catch(error => { error.message += '\n' + String(error.stdout) + String(error.stderr); throw error; });
    const status = await command('status', native);
    expect(status).toMatchObject({id: native, name: native, nativeStarted:true});
    expect(status).not.toHaveProperty('nativeSessionId');
    const root = path.join(home, '.claude-gateway', 'safemode');
    const dirs = fs.readdirSync(root).filter(n => n.startsWith('starting-'));
    expect(dirs).toHaveLength(1);
    expect(fs.lstatSync(path.join(root,dirs[0])).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(root,dirs[0]))).toBe(path.join(root,native));
    expect(fs.existsSync(path.join(root, dirs[0], 'workspace', 'diagnostics'))).toBe(true);
  });
  test('make stop terminates the gateway only, and rejects a pidfile naming safemode', async () => {
    const tools = path.join(home, 'bin');
    fs.mkdirSync(tools);
    for (const tool of ['systemctl', 'pm2']) fs.writeFileSync(path.join(tools, tool), '#!/bin/sh\nexit 1\n', {mode:0o700});
    const server = path.join(home, 'server', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(server), {recursive:true});
    fs.writeFileSync(server, 'setInterval(()=>{},1000);');
    const gateway = spawn(process.execPath, [server, 'gateway', 'start'], {stdio:'ignore'});
    const safemode = spawn(process.execPath, [server, 'safemode', '--cli', 'codex'], {stdio:'ignore'});
    const closed = new Promise<void>(resolve => gateway.once('close', () => resolve()));
    const pidfile = path.join(home,'.claude-gateway','gateway.pid');
    const testEnv = {...env, PATH:tools+path.delimiter+process.env.PATH};
    const buildRoot = path.resolve(__dirname, '../..');
    try {
      fs.writeFileSync(pidfile, gateway.pid + '\n10850\n');
      await exec('make', ['stop'], {cwd:buildRoot, env:testEnv, timeout:10000});
      await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('gateway did not stop')), 3000).unref())]);
      expect(() => process.kill(safemode.pid!, 0)).not.toThrow();
      fs.writeFileSync(pidfile, safemode.pid + '\n10850\n');
      await expect(exec('make', ['stop'], {cwd:buildRoot, env:testEnv, timeout:10000})).rejects.toThrow();
      expect(() => process.kill(safemode.pid!, 0)).not.toThrow();
    } finally { gateway.kill(); safemode.kill(); }
  });
  test.each(['claude','codex'])('%s interactive rename, busy refusal, takeover, idempotence and resume keep one native conversation', async cli => {
    const fake = path.join(home, 'native-cli'), events = path.join(home, 'events.jsonl');
    const history = path.join(home, 'native-history.jsonl');
    fs.writeFileSync(history, 'native history survives safemode deletion');
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2);
if(args[0]==='mcp'&&args[1]==='list'){console.log('[]');process.exit(0);}
if(args.includes('app-server')){
 require('readline').createInterface({input:process.stdin}).on('line',line=>{
  const q=JSON.parse(line);if(!q.id)return;
  const result=q.method==='config/read'?{config:{model_provider:'openai'}}:q.method==='account/read'?{account:{type:'chatgpt'}}:{};
  console.log(JSON.stringify({id:q.id,result}));
 });
}else {

const key=args.includes('resume')?'resume':args.includes('--resume')?'--resume':'--session-id';
const id=args[args.indexOf(key)+1];
fs.appendFileSync(process.env.HOME+'/events.jsonl',JSON.stringify({id,args,pid:process.pid})+'\\n');
if(args.includes('--print')||args.includes('exec')){
 console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
 console.log(JSON.stringify({type:'result',result:'mock diagnosis complete'}));
}else{setTimeout(()=>process.exit(0),20000);}
}
`, {mode:0o700});
    const terminal = (...args: string[]) => {
      const cmd = [process.execPath, entry, 'safemode', ...args].map(v => "'" + v.replace(/'/g, "'\\''") + "'").join(' ');
      return exec('script', ['-q','-e','-c',cmd,'/dev/null'], {env,timeout:25000}).then(()=>0, e=>e.code);
    };
    const recorded = () => fs.existsSync(events) ? fs.readFileSync(events,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
    const waitFor = async (test: () => Promise<boolean> | boolean) => {
      for(let i=0;i<60;i++){if(await test())return;await new Promise(resolve=>setTimeout(resolve,50));}
      throw new Error('mock lifecycle did not reach expected state');
    };
    let activeId: string | undefined;
    env.CODEX_BIN = fake;
    const permission = cli === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox';
    const initial = permission + (cli === 'codex' ? ' resume 44444444-4444-4444-8444-444444444444' : '');
    const first = terminal('--cli',cli,'--name','live','--params='+initial);
    try {
      await waitFor(()=>recorded().length===1);
      activeId = recorded()[0].id;
      const before = await command('status',activeId!);
      const renamed = await command('rename',activeId!,'renamed');
      expect(renamed).toMatchObject({id:activeId,name:'renamed',renamed:true});
      expect((await command('status','renamed')).owner).toEqual(before.owner);
      await expect(command('status','live')).rejects.toThrow();
      await expect(command('send','renamed','--prompt=inspect','--request-id=e2e')).rejects.toThrow();
      expect(recorded()).toHaveLength(1);
      expect(await command('send','renamed','--prompt=inspect','--request-id=e2e','--takeover')).toMatchObject({id:activeId,status:'accepted'});
      expect(await first).not.toBe(0);
      await waitFor(async()=> (await command('status',activeId!)).request?.status==='completed');
      expect(await command('send',activeId!,'--prompt=inspect','--request-id=e2e','--takeover')).toMatchObject({duplicate:true});
      const second = recorded()[1];
      expect(second.id).toBe(activeId);
      expect(second.args).toEqual(expect.arrayContaining(cli === 'claude'
        ? ['--resume',activeId,'--restricted','Read,Glob,Grep']
        : ['exec','--json','resume',activeId,'sandbox_mode="read-only"','approval_policy="never"']));
      expect(second.args).not.toContain(permission);
      const resumed = terminal('--resume',activeId!,'--params='+permission);
      await waitFor(()=>recorded().length===3);
      expect(recorded()[2].id).toBe(activeId);
      expect(recorded()[2].args).toContain(cli === 'claude' ? '--resume' : 'resume');
      expect(await command('stop',activeId!)).toMatchObject({id:activeId,stopped:true});
      expect(await resumed).not.toBe(0);
      expect((await command('status','renamed')).ownerAlive).toBe(false);
      expect(await command('delete','renamed')).toMatchObject({deleted:true});
      expect(fs.readFileSync(history,'utf8')).toContain('survives');
    } finally {
      if(activeId) await command('stop',activeId).catch(()=>{});
      await first;
    }
  }, 30000);
  test('headless native failure persists a failed receipt and releases ownership', async () => {
    fs.writeFileSync(path.join(home,'native-cli'),'#!/usr/bin/env node\nprocess.exit(7);\n',{mode:0o700});
    await expect(command('send','investigation','--prompt=fail','--request-id=failed','--wait')).rejects.toMatchObject({code:7});
    const result = await command('status','investigation','--request-id=failed');
    expect(result.request).toMatchObject({status:'failed',exitCode:7});
    expect(result.ownerAlive).toBe(false);
  });
  test('returns receipt then durable result for same native session, including a dash-leading prompt',async()=>{
    const receipt=await command('send','investigation','--prompt=--inspect this','--request-id=once');
    expect(receipt).toMatchObject({id:nativeId,requestId:'once',status:'accepted'});
    let status:any;
    for(let i=0;i<30;i++) {
      status=await command('status','investigation','--request-id=once');
      if(status.request?.status==='completed')break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    expect(status.request).toMatchObject({id:'once',status:'completed',exitCode:0});
    expect(status.id).toBe(nativeId);
    const snapshot=JSON.parse(fs.readFileSync(path.join(home,'.claude-gateway','safemode',id,'workspace','diagnostics','config.json'),'utf8'));
    expect(snapshot.marker).toBe('saved target');
    expect((await command('logs','investigation')).output).toContain('fixture diagnostic completed');
    expect(await command('send','investigation','--prompt=--inspect this','--request-id=once','--takeover')).toMatchObject({duplicate:true});
  });
});
