import { createLazyToolCatalog } from '../../mcp/lazy-tools';
import { NARRATE_TOOL } from '../../mcp/tools/narrate/module';

describe('narrate discoverability through tool_search', () => {
  const catalog = createLazyToolCatalog([NARRATE_TOOL]);
  const find = (query: string) => JSON.parse(catalog.search({ query }).content[0].text as string).tools.map((t: { name: string }) => t.name);
  test.each(['narrate', 'narrate text to speech', 'read aloud', 'text to speech audio', 'tts voice'])('"%s" finds the tool', query => {
    expect(find(query)).toEqual(['narrate']);
  });
});

// Third review of #591 (L12): tool_call refused `mcp__gateway__x`, the name a model sees the tool by.
test('tool_call accepts a gateway tool named with its mcp__gateway__ namespace, and nothing else', async () => {
  const catalog = createLazyToolCatalog([NARRATE_TOOL]);
  const dispatched: string[] = [];
  const dispatch = async (name: string) => { dispatched.push(name); return { content: [{ type: 'text' as const, text: 'ok' }] }; };
  expect((await catalog.call({ name: `mcp__gateway__${NARRATE_TOOL.name}`, arguments: {} }, dispatch)).isError).toBeUndefined();
  expect((await catalog.call({ name: `mcp__other__${NARRATE_TOOL.name}`, arguments: {} }, dispatch)).isError).toBe(true);
  expect(dispatched).toEqual([NARRATE_TOOL.name]);
});
