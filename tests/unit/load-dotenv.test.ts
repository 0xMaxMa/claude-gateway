import { parseDotenv } from '../../src/load-dotenv';

// ---------------------------------------------------------------------------
// U-DE: the shared `.env` line parser.
//
// Used by both `~/.claude-gateway/.env` (loadGatewayDotenv) and the per-agent
// `agents/<id>/.env` files (src/config/agent-env.ts). The two used to carry
// separate copies of this loop and had already drifted on quote handling —
// which is the silent case, because a quoted token still resolves its ${VAR},
// so the config loads clean and only the receiver notices.
// ---------------------------------------------------------------------------
describe('parseDotenv', () => {
  it('U-DE-01: parses pairs in file order and trims surrounding whitespace', () => {
    expect(parseDotenv('A=1\n  B = 2  \nC=3\n')).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
      { key: 'C', value: '3' },
    ]);
  });

  it('U-DE-02: strips surrounding quotes from the value', () => {
    expect(parseDotenv('T="123:ABC-def"\nU=\'sk-live\'\n')).toEqual([
      { key: 'T', value: '123:ABC-def' },
      { key: 'U', value: 'sk-live' },
    ]);
  });

  it('U-DE-03: keeps quotes that are inside the value', () => {
    // Only the outermost pair is shell quoting; an inner quote is data.
    expect(parseDotenv('T=a"b"c\n')).toEqual([{ key: 'T', value: 'a"b"c' }]);
  });

  it('U-DE-04: keeps `=` and `#` that appear inside a value', () => {
    // Tokens contain both, and only the first `=` separates key from value.
    expect(parseDotenv('T=a=b#c\n')).toEqual([{ key: 'T', value: 'a=b#c' }]);
  });

  it('U-DE-05: drops blanks, comments and lines with no key', () => {
    expect(parseDotenv('\n# comment\n   \n=novalue\nnot-a-pair\nA=1\n')).toEqual([
      { key: 'A', value: '1' },
    ]);
  });

  it('U-DE-06: yields an empty value for a key with nothing after the `=`', () => {
    // What `agent_update remove_channel` can leave behind; the caller decides
    // what an empty token means, the parser does not drop the key.
    expect(parseDotenv('T=\n')).toEqual([{ key: 'T', value: '' }]);
  });
});
