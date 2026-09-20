import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
const exec = promisify(execFile);
const entry = path.resolve(__dirname, '../../dist/entry.js');

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
    const {stdout}=await exec(process.execPath,[entry,'safemode',...args,'--json'],{env,timeout:10000});
    return JSON.parse(stdout);
  }
  test.each(['claude', 'codex'])('interactive %s params reach the native process, retain imported ID and cannot be imported twice', async cli => {
    const capture = path.join(home, 'captured.json');
    const fake = path.join(home, 'native-cli');
    fs.writeFileSync(fake, '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.HOME + "/captured.json", JSON.stringify(process.argv.slice(2)));\n', {mode: 0o700});
    const importedId = '22222222-2222-4222-8222-222222222222';
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const permission = cli === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox';
    const resume = cli === 'claude' ? '--resume' : 'resume';
    env.CODEX_BIN = fake;
    const cmd = [process.execPath, entry, 'safemode', '--cli', cli, '--name', 'imported',
      '--params', permission + ' ' + resume + ' ' + importedId].map(quote).join(' ');
    await exec('script', ['-q', '-e', '-c', cmd, '/dev/null'], {env, timeout: 15000});
    const args = JSON.parse(fs.readFileSync(capture, 'utf8'));
    expect(args.slice(0, 3)).toEqual([permission, resume, importedId]);
    expect(args).not.toContain('--permission-mode');
    expect((await command('status', 'imported')).nativeSessionId).toBe(importedId);
    await expect(exec('script', ['-q', '-e', '-c', cmd.replace("'imported'", "'duplicate'"), '/dev/null'], {env, timeout: 15000})).rejects.toThrow();
  });
  test('returns receipt then durable result for same native session, including a dash-leading prompt',async()=>{
    const receipt=await command('send','investigation','--prompt=--inspect this','--request-id=once');
    expect(receipt).toMatchObject({id,requestId:'once',status:'accepted'});
    let status:any;
    for(let i=0;i<30;i++) {
      status=await command('status','investigation','--request-id=once');
      if(status.request?.status==='completed')break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    expect(status.request).toMatchObject({id:'once',status:'completed',exitCode:0});
    expect(status.nativeSessionId).toBe(nativeId);
    const snapshot=JSON.parse(fs.readFileSync(path.join(home,'.claude-gateway','safemode',id,'workspace','diagnostics','config.json'),'utf8'));
    expect(snapshot.marker).toBe('saved target');
    expect((await command('logs','investigation')).output).toContain('fixture diagnostic completed');
    expect(await command('send','investigation','--prompt=--inspect this','--request-id=once','--takeover')).toMatchObject({duplicate:true});
  });
});
