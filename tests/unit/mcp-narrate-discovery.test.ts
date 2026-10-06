import { createLazyToolCatalog } from '../../mcp/lazy-tools';
import { NARRATE_TOOL } from '../../mcp/tools/narrate/module';

describe('narrate discoverability through tool_search', () => {
  const catalog = createLazyToolCatalog([NARRATE_TOOL]);
  const find = (query: string) => JSON.parse(catalog.search({ query }).content[0].text as string).tools.map((t: { name: string }) => t.name);
  test.each(['narrate', 'narrate text to speech', 'read aloud', 'text to speech audio', 'tts voice'])('"%s" finds the tool', query => {
    expect(find(query)).toEqual(['narrate']);
  });
});
