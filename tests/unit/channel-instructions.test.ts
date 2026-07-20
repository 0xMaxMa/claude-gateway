import { buildChannelInstructions } from '../../mcp/instructions';

describe('buildChannelInstructions', () => {
  const IMAGE_SUBSTRINGS = [
    'IMAGE GENERATION IS BUILT IN',
    'byok',
    'NEVER tell the user to install an app',
    'isn\'t set up with a working model yet',
    'try the NEXT usable model', // BYOK-first + retry-on-no_supply behavior
  ];

  it('includes image guidance when imageEnabled=true', () => {
    const out = buildChannelInstructions(true);
    for (const sub of IMAGE_SUBSTRINGS) {
      expect(out).toContain(sub);
    }
  });

  it('omits all image guidance when imageEnabled=false', () => {
    const out = buildChannelInstructions(false);
    for (const sub of IMAGE_SUBSTRINGS) {
      expect(out).not.toContain(sub);
    }
  });

  it('preserves the existing baseline channel instructions in both modes', () => {
    expect(buildChannelInstructions(true)).toContain('reply tool');
    expect(buildChannelInstructions(false)).toContain('reply tool');
  });
});
