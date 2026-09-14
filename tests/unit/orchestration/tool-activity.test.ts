import { toolActivity, ToolActivity } from '../../../src/orchestration/tool-activity';
test('tool activity deduplicates snapshots, excludes hidden reasoning/results and bounds previews', () => {
  const out: ToolActivity[] = [], parse = toolActivity(e => out.push(e));
  const assistant = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'private reasoning' },
    { type: 'tool_use', id: 'call', name: 'Read', input: { path: '/fixture.txt', api_key: 'secret', password: 'secret', large: 'x'.repeat(100000) } },
  ] } });
  parse('not JSON'); parse('{"message":{"content":{}}}'); parse(assistant); parse(assistant);
  const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'private raw tool output', is_error: true }] } });
  parse(result); parse(result);
  expect(out).toHaveLength(2); expect(out[1]).toMatchObject({ type: 'tool_result', id: 'call', is_error: true });
  expect(JSON.stringify(out)).not.toMatch(/secret|private/); expect(JSON.stringify(out).length).toBeLessThan(4096);
});
