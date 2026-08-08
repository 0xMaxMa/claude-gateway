/**
 * Unit tests for the public media-serving decision (src/api/public-media-headers.ts).
 *
 * This is the stored-XSS gate for the public `/public/:token` route: an agent can
 * write ANY file under its media root, so the ONLY thing standing between a `.svg` /
 * `.html` file and script execution on the gateway origin is this extension → serve
 * decision. We lock in that raster images serve inline with a safe explicit type, and
 * that everything executable (svg/html/xml/unknown) is forced to a non-executable
 * octet-stream download — plus that the download filename can't inject a header.
 */
import { safeMediaHeaders } from '../../src/api/public-media-headers';

describe('safeMediaHeaders — inline raster allowlist', () => {
  const cases: Array<[string, string]> = [
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'],
    ['.gif', 'image/gif'],
  ];
  it.each(cases)('serves %s inline with %s and no disposition', (ext, type) => {
    const r = safeMediaHeaders(ext, `pic${ext}`);
    expect(r.contentType).toBe(type);
    expect(r.disposition).toBeUndefined();
  });

  it('matches extensions case-insensitively', () => {
    expect(safeMediaHeaders('.PNG', 'pic.PNG').contentType).toBe('image/png');
    expect(safeMediaHeaders('.JPeG', 'pic.JPeG').contentType).toBe('image/jpeg');
  });
});

describe('safeMediaHeaders — forced download for executable / unknown', () => {
  it.each(['.svg', '.html', '.htm', '.xml', '.txt', '.pdf', '', '.exe'])(
    'forces %s to octet-stream attachment',
    (ext) => {
      const r = safeMediaHeaders(ext, `file${ext}`);
      expect(r.contentType).toBe('application/octet-stream');
      expect(r.disposition).toBe(`attachment; filename="file${ext}"`);
    },
  );

  it('never serves svg as image/svg+xml inline', () => {
    const r = safeMediaHeaders('.svg', 'evil.svg');
    expect(r.contentType).not.toContain('svg');
    expect(r.disposition).toContain('attachment');
  });
});

describe('safeMediaHeaders — filename hardening', () => {
  it('strips quotes, backslashes and CR/LF so the header can not be injected', () => {
    const r = safeMediaHeaders('.svg', 'a"b\\c\r\nContent-Type: text/html');
    expect(r.disposition).toBe('attachment; filename="abcContent-Type: text/html"');
    expect(r.disposition).not.toContain('"a"');
    expect(r.disposition).not.toContain('\r');
    expect(r.disposition).not.toContain('\n');
  });

  it('falls back to a safe default when the name sanitizes to empty', () => {
    const r = safeMediaHeaders('.bin', '"""');
    expect(r.disposition).toBe('attachment; filename="download"');
  });
});
