import { probeCliSkills } from '../../../src/orchestration/cli-skills';
import { probeMcpConfiguration } from '../../../src/orchestration/capabilities';
import { validateJevConfig } from '../../../src/jev/validation';
import { tmpdir } from 'os';
const original = { ...process.env };
beforeEach(() => {
  validateJevConfig({enabled:true,provider:'typesafe',model:'jev',apiKeyEnv:'PRIVATE_DISCOVERY_JEV_TOKEN'});
  Object.assign(process.env,{TYPESAFE_API_KEY:'vendor-a',JEV_API_KEY:'vendor-b',PRIVATE_DISCOVERY_JEV_TOKEN:'vendor-c',ANTHROPIC_API_KEY:'native-auth'});
});
afterEach(() => {process.env={...original};});
const guard = `if(process.env.TYPESAFE_API_KEY||process.env.JEV_API_KEY||process.env.PRIVATE_DISCOVERY_JEV_TOKEN||process.env.ANTHROPIC_API_KEY!=='native-auth')process.exit(47);`;
test('real native skill-discovery child sees native auth but no gateway Jev keys', async () => {
  const script=guard+`process.stdin.once('data',data=>{const q=JSON.parse(data);process.stdout.write(JSON.stringify({type:'control_response',response:{request_id:q.request_id,subtype:'success',response:{commands:[{name:'safe',description:'Metadata only'}]}}})+'\\n');});setInterval(()=>{},1000);`;
  expect(await probeCliSkills(process.execPath,['-e',script],tmpdir())).toEqual([{name:'safe',description:'Metadata only',argumentHint:'',aliases:[]}]);
});
test('real native MCP-configuration probe keeps native auth and strips gateway Jev keys', async () => {
  const script=guard+`require('readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:q.request_id,response:q.request.subtype==='initialize'?{}:{mcpServers:[]}}})+'\\n');});`;
  expect(await probeMcpConfiguration(process.execPath,['-e',script],tmpdir())).toEqual({});
});
