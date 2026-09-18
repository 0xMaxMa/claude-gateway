import { resolveSkill, resolveNamedSkill, skillCatalog } from '../../../src/orchestration/skills';
import { splitSpeechResponse } from '../../../src/orchestration/speech';
import { ORCHESTRATION_RESPONSE_SCHEMA } from '../../../src/orchestration/response-schema';
import { parseSkill } from '../../../src/skills/parser';
import { runtimeProfileArgs } from '../../../src/session/runtime-profile';
import { resolveOrchestrationConfig } from '../../../src/orchestration/config';
const skill = parseSkill('---\nname: review\ndescription: Review\n---\nReview $ARGUMENTS', { source: 'workspace', filePath: '/skills/review/SKILL.md' })!;
const registry = { skills: new Map([['review', skill], ['model', skill], ['hidden', { ...skill, userInvocable: false }]]) };

test('deterministic skill detection respects installed catalog, builtins, namespaces, whitespace and hidden skills', () => {
  expect(resolveSkill('/review\t465', 'api', registry)).toMatchObject({ name: 'review', args: '465' });
  expect(resolveSkill('/review@mybot 465', 'telegram', registry)).toMatchObject({ name: 'review', args: '465' });
  for (const text of ['/missing x', '/model x', '/hidden x', 'please /review x', '/review-other x', '/../../review']) expect(resolveSkill(text, 'api', registry)).toBeUndefined();
});

test('agent cannot use Skill while a worker can load only its gateway-built skill plugin', () => {
  const agentSession = runtimeProfileArgs({ role: 'agent', mcpConfigPath: '/mcp', overlay: '', skillPluginDir: '/skill-bundle' }, []);
  const worker = runtimeProfileArgs({ role: 'worker', mcpConfigPath: '/mcp', overlay: '', skillPluginDir: '/skill-bundle' }, []);
  expect(agentSession[agentSession.indexOf('--tools') + 1]).toBe(''); expect(agentSession).not.toContain('--plugin-dir');
  expect(worker[worker.indexOf('--tools') + 1].split(',')).toContain('Skill');
  expect(worker).toContain('--plugin-dir'); expect(worker).toContain('--strict-mcp-config');
  expect(JSON.parse(worker[worker.indexOf('--settings') + 1]).disableAllHooks).toBe(true);
});

test('invalid and overlong speech never falls back to reading the full report', () => {
  const report = 'A detailed report. '.repeat(100);
  expect(splitSpeechResponse(report)).toEqual({ display: report, spoken: '', outcome: 'plain' });
  for (const spoken_text of ['a'.repeat(601), '```code```']) expect(splitSpeechResponse(JSON.stringify({ display_text: report, spoken_text }))).toEqual({ display: report, spoken: '', outcome: 'structured' });
  expect(splitSpeechResponse(JSON.stringify({ display_text: report, spoken_text: 'พบปัญหาหนึ่งจุดครับ' }))).toEqual({ display: report, spoken: 'พบปัญหาหนึ่งจุดครับ', outcome: 'structured' });
});

test('channels default to proactive existing receive path; voice notes need no TTS voice ID', () => {
  expect(resolveOrchestrationConfig().conversation.notificationPolicy).toBe('existing_receive_path');
  expect(resolveOrchestrationConfig({ enabled: true, voice: { notes: { enabled: true } } }).voice).toMatchObject({ enabled: false, notes: { enabled: true, model: 'scribe_v2' }, tts: { voiceId: '' } });
});


test('implicit skill catalog hides worker bodies and paths; named dispatch rejects unknown, hidden and path names', () => {
  const catalog = skillCatalog(registry);
  expect(catalog).toContain('"name":"review"');
  expect(catalog).not.toContain('hidden'); expect(catalog).not.toContain('/skills/'); expect(catalog).not.toContain('$ARGUMENTS');
  expect(resolveNamedSkill('review', '465', registry)).toMatchObject({ name: 'review', args: '465', content: skill.content });
  for (const name of ['missing', 'hidden', '../review', '/review']) expect(resolveNamedSkill(name, '', registry)).toBeUndefined();
  expect(resolveNamedSkill('review', {}, registry)).toBeUndefined();
});

test('uses explicit trailing speech JSON after CLI progress text without reading the prefix or accepting truncated JSON', () => {
  const fields = { display_text: 'Worker is running', spoken_text: 'กำลังรันอยู่ครับ' };
  expect(splitSpeechResponse('Progress before a tool call.\n\n' + JSON.stringify(fields))).toEqual({ display: fields.display_text, spoken: fields.spoken_text, outcome: 'structured' });
  expect(splitSpeechResponse('Progress.\n```json\n' + JSON.stringify(fields) + '\n```')).toEqual({ display: fields.display_text, spoken: fields.spoken_text, outcome: 'structured' });
  // A truncated object is still not accepted as structured, and it is no longer published
  // either: only the prose that preceded it reaches the user.
  const partial = 'Progress.\n' + JSON.stringify(fields).slice(0, -1);
  expect(splitSpeechResponse(partial)).toEqual({ display: 'Progress.', spoken: 'Progress.', outcome: 'unreadable' });
  const long = JSON.stringify({ ...fields, spoken_text: 'x'.repeat(601) });
  expect(splitSpeechResponse('Progress.\n' + long)).toEqual({ display: fields.display_text, spoken: '', outcome: 'structured' });
});

test('host workers use default CLI tools and inherited settings instead of isolated execution flags', () => {
  const args = runtimeProfileArgs({ role: 'worker', hostExecution: true, mcpConfigPath: '/task-mcp', overlay: 'task', context: 'identity' }, []);
  expect(args).toEqual(expect.arrayContaining(['--tools', 'default', '--mcp-config', '/task-mcp']));
  expect(args).not.toContain('--strict-mcp-config');
  expect(args).not.toContain('--settings');
  expect(args).not.toContain('--setting-sources');
  const agentArgs = runtimeProfileArgs({ role: 'agent', hostExecution: true, mcpConfigPath: '/agent-mcp', overlay: '' }, []);
  expect(agentArgs).toContain('--strict-mcp-config');
});

test('the union response schema reaches the CLI for Agent profiles only, and never a worker',()=>{
 const profile={role:'agent' as const,mcpConfigPath:'/mcp',overlay:''};
 const args=runtimeProfileArgs({...profile,responseSchema:ORCHESTRATION_RESPONSE_SCHEMA},[]);
 // Only the main text field is required: an ordinary turn satisfies the union with exactly
 // what it already returned, while the mode-specific fields stay optional.
 expect(JSON.parse(args[args.indexOf('--json-schema')+1])).toMatchObject({required:['display_text'],additionalProperties:false,properties:{display_text:{type:'string'},spoken_text:{type:'string'},notify_user:{type:'boolean'}}});
 // minLength/maxLength are not enforced server-side by structured outputs, so they must not
 // appear here; the spoken budget is enforced by splitSpeechResponse/progressReviewResult.
 expect(args[args.indexOf('--json-schema')+1]).not.toMatch(/minLength|maxLength/);
 expect(runtimeProfileArgs(profile,[])).not.toContain('--json-schema');
 expect(runtimeProfileArgs({...profile,role:'worker',responseSchema:ORCHESTRATION_RESPONSE_SCHEMA},[])).not.toContain('--json-schema');
 expect(splitSpeechResponse('ได้เลยค่ะ **กำลังตรวจให้**')).toEqual({display:'ได้เลยค่ะ **กำลังตรวจให้**',spoken:'ได้เลยค่ะ กำลังตรวจให้',outcome:'plain'});
 for(const text of ['https://example.com','```code```','a'.repeat(601)])expect(splitSpeechResponse(text).spoken).toBe('');
});
