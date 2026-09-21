import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveCodexCredentials, inspectCodexAccount, codexSafemodeEnvironment } from '../../../src/session/codex-auth';
let root: string, bin: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-native-auth-'));
  mkdirSync(join(root, '.codex'));
  bin = join(root, 'codex');
  writeFileSync(bin, `#!${process.execPath}
const fs=require('fs'),path=require('path'),rl=require('readline').createInterface({input:process.stdin});
rl.on('line',line=>{const q=JSON.parse(line); if(!q.id)return;
const fixture=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'fixture.json')));fs.appendFileSync(path.join(process.env.HOME,'calls.jsonl'),JSON.stringify({method:q.method,refresh:q.params?.refreshToken})+'\\n');
let result=q.method==='config/read'?{config:fixture.config}:q.method==='account/read'?{account:fixture.account}:q.method==='getAuthStatus'?fixture.exported:{};
process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');});
`, { mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function fixture(config: any, account: any = {type:'apiKey'}, auth: any = {auth_mode:'apikey',OPENAI_API_KEY:'native-secret'}) {
  writeFileSync(join(root,'fixture.json'), JSON.stringify({config,account,exported:{authMethod:auth.auth_mode ?? 'apikey',authToken:auth.OPENAI_API_KEY ?? auth.tokens?.access_token}}));
  writeFileSync(join(root,'.codex','auth.json'), JSON.stringify(auth));
}
const config = {model_provider:'fixture',cli_auth_credentials_store:'file',model_providers:{fixture:{base_url:'https://native.example/v1',wire_api:'responses',requires_openai_auth:true}}};
test('uses native API-key login and the native provider instead of Claude credentials', async () => {
  fixture(config);
  const result=await resolveCodexCredentials({bin,env:{HOME:root,PATH:process.env.PATH,ANTHROPIC_API_KEY:'wrong-secret'}});
  expect(result).toMatchObject({baseUrl:'https://native.example/v1',key:'native-secret'});
  expect(result.fingerprint).not.toContain('secret');
});
test('resolves selected provider env auth without requiring an auth.json login', async () => {
  fixture({...config,model_providers:{fixture:{base_url:'https://native.example/v1',env_key:'FIXTURE_KEY'}}},null,{});
  await expect(resolveCodexCredentials({bin,env:{HOME:root,FIXTURE_KEY:'env-key'}})).resolves.toMatchObject({key:'env-key'});
});
test.each(['file','keyring','auto'])('uses native ChatGPT %s auth without copying its refresh token', async storage => {
  const token = 'header.' + Buffer.from(JSON.stringify({sub:'user-one','https://api.openai.com/auth':{chatgpt_account_id:'account-one',chatgpt_plan_type:'plus'}})).toString('base64url') + '.signature';
  fixture({model_provider:'openai',cli_auth_credentials_store:storage},{type:'chatgpt'}, {auth_mode:'chatgpt', tokens:{access_token:token,refresh_token:'do-not-copy'}});
  const result=await resolveCodexCredentials({bin,env:{HOME:root}});
  expect(result.chatgpt).toEqual({accessToken:token,chatgptAccountId:'account-one',chatgptPlanType:'plus'});
  expect(JSON.stringify(result)).not.toContain('do-not-copy');
  expect(result.key).toBe('');
});
test('keyring API auth uses the native export, never the stale auth file', async () => {
  fixture({...config,cli_auth_credentials_store:'keyring'});
  writeFileSync(join(root,'.codex','auth.json'),JSON.stringify({OPENAI_API_KEY:'stale'}));
  await expect(resolveCodexCredentials({bin,env:{HOME:root}})).resolves.toMatchObject({key:'native-secret'});
});
test('missing native export fails without falling back to a stale auth file', async () => {
  fixture(config,null,{});
  writeFileSync(join(root,'.codex','auth.json'),JSON.stringify({OPENAI_API_KEY:'stale'}));
  await expect(resolveCodexCredentials({bin,env:{HOME:root}})).rejects.toMatchObject({code:'CODEX_AUTH_REQUIRED'});
});
test('ChatGPT account identity survives token rotation and changes on account switch', async () => {
  const setup=(account:string,rotation:string)=>fixture({model_provider:'openai'},{type:'chatgpt'},{auth_mode:'chatgpt',tokens:{access_token:'header.'+Buffer.from(JSON.stringify({sub:'user-one',rotation,'https://api.openai.com/auth':{chatgpt_account_id:account}})).toString('base64url')+'.sig'}});
  setup('first','old');const first=await resolveCodexCredentials({bin,env:{HOME:root}});
  setup('first','new');expect((await resolveCodexCredentials({bin,env:{HOME:root}})).fingerprint).toBe(first.fingerprint);
  setup('second','new');expect((await resolveCodexCredentials({bin,env:{HOME:root}})).fingerprint).not.toBe(first.fingerprint);
});
test('explicit worker settings retain precedence and never use Claude auth', async () => {
  await expect(resolveCodexCredentials({bin,baseUrl:'https://explicit.example/v1',apiKeyEnv:'WORKER_KEY',env:{WORKER_KEY:'explicit'}})).resolves.toMatchObject({key:'explicit'});
  await expect(resolveCodexCredentials({bin,apiKeyEnv:'CLAUDE_CODE_OAUTH_TOKEN',env:{CLAUDE_CODE_OAUTH_TOKEN:'wrong'}})).rejects.toMatchObject({code:'CODEX_PROVIDER_INVALID'});
});
test('missing binary gives a bounded actionable error without raw native stderr', async () => {
  await expect(inspectCodexAccount(join(root,'missing'))).rejects.toMatchObject({code:'CODEX_UNAVAILABLE'});
});
test('rotation changes the pool fingerprint before a different account can resume', async () => {
  fixture(config);
  const first=await resolveCodexCredentials({bin,env:{HOME:root}});
  fixture(config,{type:'apiKey'},{OPENAI_API_KEY:'rotated'});
  expect((await resolveCodexCredentials({bin,env:{HOME:root}})).fingerprint).not.toBe(first.fingerprint);
});


test('interactive params retain only the selected native provider env key', async () => {
  fixture({...config,model_providers:{fixture:{env_key:'FIXTURE_KEY'}}},null,{});
  const result=await codexSafemodeEnvironment(bin,{HOME:root},{nativeArgs:['--model','gpt-fixture'],source:{HOME:root,FIXTURE_KEY:'selected',UNRELATED_KEY:'private',GITHUB_TOKEN:'private'}});
  expect(result).toEqual({HOME:root,FIXTURE_KEY:'selected'});
});
test('profile provider and header credentials are selected before CLI overrides', async () => {
  fixture({...config,model_providers:{fixture:{env_key:'FIRST_KEY'},override:{env_key:'OVERRIDE_KEY'}}},null,{});
  writeFileSync(join(root,'.codex','alternate.config.toml'),'model_provider="alternate"\n[model_providers.alternate]\nenv_key="PROFILE_KEY"\n[model_providers.alternate.env_http_headers]\nX-Tenant="TENANT_KEY"\n');
  const source={HOME:root,FIRST_KEY:'first',PROFILE_KEY:'profile',TENANT_KEY:'tenant',OVERRIDE_KEY:'override'};
  expect(await codexSafemodeEnvironment(bin,{HOME:root},{nativeArgs:['-p','alternate'],source})).toEqual({HOME:root,PROFILE_KEY:'profile',TENANT_KEY:'tenant'});
  expect(await codexSafemodeEnvironment(bin,{HOME:root},{nativeArgs:['--profile=alternate','--config=model_provider=override'],source})).toEqual({HOME:root,OVERRIDE_KEY:'override'});
});
test('native config overrides can define a new selected provider credential', async () => {
  fixture(config,null,{});
  const result=await codexSafemodeEnvironment(bin,{HOME:root},{nativeArgs:['-cmodel_provider="custom"','-c','model_providers.custom.env_key="CUSTOM_KEY"'],source:{HOME:root,CUSTOM_KEY:'custom'}});
  expect(result).toEqual({HOME:root,CUSTOM_KEY:'custom'});
});
test('legacy profile config still resolves its selected native provider', async () => {
  fixture({...config,profiles:{legacy:{model_provider:'other'}},model_providers:{other:{env_key:'OTHER_KEY'}}},null,{});
  expect(await codexSafemodeEnvironment(bin,{HOME:root},{nativeArgs:['-p','legacy'],source:{HOME:root,OTHER_KEY:'other'}})).toEqual({HOME:root,OTHER_KEY:'other'});
});
test('interactive params delegate missing login to native CLI but defaults require readiness', async () => {
  fixture(config,null,{});
  await expect(codexSafemodeEnvironment(bin,{HOME:root},{nativeArgs:[],source:{HOME:root}})).resolves.toEqual({HOME:root});
  await expect(codexSafemodeEnvironment(bin,{HOME:root},{source:{HOME:root}})).rejects.toMatchObject({code:'CODEX_AUTH_REQUIRED'});
});
test.each(['GITHUB_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','GATEWAY_KEY','NODE_OPTIONS'])('never forwards protected credential %s via native params', async name => {
  fixture({...config,model_providers:{fixture:{env_key:name}}},null,{});
  await expect(codexSafemodeEnvironment(bin,{HOME:root},{nativeArgs:[],source:{HOME:root,[name]:'private'}})).rejects.toMatchObject({code:'CODEX_AUTH_REQUIRED'});
});
test('malformed profile fails without exposing its contents', async () => {
  fixture(config,null,{});
  writeFileSync(join(root,'.codex','broken.config.toml'),'secret="private-token\n');
  await expect(codexSafemodeEnvironment(bin,{HOME:root},{nativeArgs:['--profile','broken'],source:{HOME:root}})).rejects.toMatchObject({code:'CODEX_CONFIG_UNAVAILABLE',message:expect.not.stringContaining('private-token')});
});

test('concurrent native refresh requests share one CLI probe', async () => {
  fixture(config);
  await Promise.all(Array.from({length:8},()=>resolveCodexCredentials({bin,env:{HOME:root},refreshToken:true})));
  const calls=require('fs').readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  expect(calls.filter((c:any)=>c.method==='getAuthStatus')).toEqual([{method:'getAuthStatus',refresh:true}]);
});
test.each([null,{}, {sub:'user'}, {'https://api.openai.com/auth':{chatgpt_account_id:'account-without-user'}}])('malformed ChatGPT identity is an actionable readiness error (%j)', claims => {
  fixture({model_provider:'openai'},{type:'chatgpt'},{auth_mode:'chatgpt',tokens:{access_token:'header.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.secret'}});
  return expect(resolveCodexCredentials({bin,env:{HOME:root}})).rejects.toMatchObject({code:'CODEX_AUTH_REQUIRED',message:expect.not.stringContaining('.secret')});
});
