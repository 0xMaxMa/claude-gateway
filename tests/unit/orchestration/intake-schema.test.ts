import {AGENT_TASK_TOOLS} from '../../../src/orchestration/agent-tool-schemas';
import {containerTaskTools} from '../../../src/orchestration/bridge';

test('host and container advertise the deferred-dispatch resolution contract',()=>{
 for(const tools of [AGENT_TASK_TOOLS,containerTaskTools('agent')]){
  const schema=tools.find(t=>t.name==='conversation_intake')!.inputSchema as any;
  expect(schema.properties.mode.enum).toContain('resolve');
  expect(schema.properties.resolution.type).toBe('string');
  expect(schema.properties.task_id.type).toBe('string');
  expect(schema.additionalProperties).toBe(false);
 }
});
