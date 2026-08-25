import { colorsEnabled, paletteFor } from '../../src/cli/colors';

describe('cli colours', () => {
  describe('colorsEnabled', () => {
    it('is off for a non-TTY stream', () => {
      expect(colorsEnabled({ isTTY: false }, {})).toBe(false);
      expect(colorsEnabled(undefined, {})).toBe(false);
    });

    it('is on for a TTY', () => {
      expect(colorsEnabled({ isTTY: true }, {})).toBe(true);
    });

    it('NO_COLOR wins over a TTY and over FORCE_COLOR', () => {
      expect(colorsEnabled({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
      expect(colorsEnabled({ isTTY: true }, { NO_COLOR: '' })).toBe(true); // empty = unset, per the spec
      expect(colorsEnabled({ isTTY: false }, { NO_COLOR: '1', FORCE_COLOR: '1' })).toBe(false);
    });

    it('FORCE_COLOR turns colour on for a piped stream, but FORCE_COLOR=0 does not', () => {
      expect(colorsEnabled({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
      expect(colorsEnabled({ isTTY: false }, { FORCE_COLOR: '0' })).toBe(false);
      expect(colorsEnabled({ isTTY: false }, { FORCE_COLOR: '' })).toBe(false);
    });
  });

  describe('paletteFor', () => {
    it('paints when enabled', () => {
      const c = paletteFor({ isTTY: true }, {});
      expect(c.enabled).toBe(true);
      expect(c.bold('hi')).toBe('\x1b[1mhi\x1b[0m');
      expect(c.green('ok')).toBe('\x1b[32mok\x1b[0m');
      expect(c.red('no')).toBe('\x1b[31mno\x1b[0m');
    });

    it('is the identity function when disabled — call sites can never leak escapes', () => {
      const c = paletteFor({ isTTY: false }, {});
      expect(c.enabled).toBe(false);
      for (const paint of [c.bold, c.dim, c.red, c.green, c.yellow, c.cyan]) {
        expect(paint('plain')).toBe('plain');
      }
    });

    it('painting never changes the visible length of the string', () => {
      const c = paletteFor({ isTTY: true }, {});
      // eslint-disable-next-line no-control-regex
      expect(c.cyan('abc'.padEnd(10)).replace(/\x1b\[[0-9;]*m/g, '')).toHaveLength(10);
    });
  });
});
