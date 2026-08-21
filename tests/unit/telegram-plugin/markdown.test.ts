/**
 * Unit tests for hasMarkdown() and toTelegramHtml() from src/telegram/markdown.ts
 */
import { containsTelegramHtml, hasMarkdown, normalizeTelegramLineBreaks, resolveTelegramReplyFormat, toTelegramHtml } from '../../../src/telegram/markdown'

describe('hasMarkdown()', () => {
  test('detects **bold**', () => {
    expect(hasMarkdown('This is **bold** text')).toBe(true)
  })

  test('detects inline code', () => {
    expect(hasMarkdown('Use `npm install` to install')).toBe(true)
  })

  test('detects code block', () => {
    expect(hasMarkdown('```\nconst x = 1\n```')).toBe(true)
  })

  test('detects markdown header', () => {
    expect(hasMarkdown('# Title\nsome text')).toBe(true)
  })

  test('detects table row', () => {
    expect(hasMarkdown('| col1 | col2 |\n|---|---|\n| a | b |')).toBe(true)
  })

  test('detects markdown link', () => {
    expect(hasMarkdown('See [docs](https://example.com) for more')).toBe(true)
  })

  test('plain text returns false', () => {
    expect(hasMarkdown('just some plain text')).toBe(false)
  })

  test('single asterisk is not markdown', () => {
    expect(hasMarkdown('price is 5 * 2 = 10')).toBe(false)
  })

  test('plain URL without link syntax is false', () => {
    expect(hasMarkdown('visit https://example.com')).toBe(false)
  })

  test('detects *italic*', () => {
    expect(hasMarkdown('this is *italic* text')).toBe(true)
  })

  test('detects bullet list', () => {
    expect(hasMarkdown('- item one\n- item two')).toBe(true)
  })

  test('single asterisk math expression is not markdown', () => {
    expect(hasMarkdown('price is 5 * 2 = 10')).toBe(false)
  })

  test('detects _italic_', () => {
    expect(hasMarkdown('this is _italic_ text')).toBe(true)
  })
})

describe('normalizeTelegramLineBreaks()', () => {
  test.each(['&lt;br&gt;', '&lt;br/&gt;', '&lt;br /&gt;', '&lt;BR&gt;'])('converts %s to a newline', tag => {
    expect(normalizeTelegramLineBreaks(`first${tag}second`)).toBe('first\nsecond')
  })
})

describe('containsTelegramHtml()', () => {
  test.each([
    ['<b>x</b>', 'bold'],
    ['<code>y</code>', 'code'],
    ['<a href="https://e.com">l</a>', 'link'],
    ['<pre>block</pre>', 'pre'],
    ['<tg-spoiler>s</tg-spoiler>', 'spoiler'],
  ])('detects %s (%s)', input => {
    expect(containsTelegramHtml(input)).toBe(true)
  })

  test.each([
    ['plain text with no tags', 'plain'],
    ['5 < 6 and 7 > 3', 'bare comparisons'],
    ['<script>alert(1)</script>', 'non-whitelist tag'],
    ['<div>x</div>', 'non-whitelist div'],
  ])('returns false for %s (%s)', input => {
    expect(containsTelegramHtml(input)).toBe(false)
  })
})

describe('toTelegramHtml() preserves agent-authored Telegram HTML tags', () => {
  // Regression for #365: a directly-written <b>/<code>/etc. mixed with markdown
  // was escaped to literal &lt;b&gt; while markdown-derived tags rendered.
  test('mixed markdown and literal HTML tags both render', () => {
    expect(toTelegramHtml('**bold** <b>x</b> [l](https://e.com)')).toBe(
      '<b>bold</b> <b>x</b> <a href="https://e.com">l</a>',
    )
  })

  test('preserves a lone <code> tag with no markdown', () => {
    expect(toTelegramHtml('<code>/update-agent</code> route')).toBe('<code>/update-agent</code> route')
  })

  test('preserves <b>, <i> and <a> together', () => {
    expect(toTelegramHtml('<b>h</b>\n<i>note</i> and <a href="https://e.com">link</a>')).toBe(
      '<b>h</b>\n<i>note</i> and <a href="https://e.com">link</a>',
    )
  })

  test('escapes non-whitelist tags instead of passing them through', () => {
    expect(toTelegramHtml('danger <script>alert(1)</script> end')).toBe(
      'danger &lt;script&gt;alert(1)&lt;/script&gt; end',
    )
  })

  test('a tag inside inline code stays literal (escaped within <code>)', () => {
    expect(toTelegramHtml('talk about `<b>` here')).toBe('talk about <code>&lt;b&gt;</code> here')
  })

  test('bare < with a space is still escaped, not treated as a tag', () => {
    expect(toTelegramHtml('a < c > d')).toBe('a &lt; c &gt; d')
  })
})

describe('toTelegramHtml()', () => {
  describe('plain text escaping', () => {
    test('escapes & < > in plain text', () => {
      expect(toTelegramHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
    })

    test('simple text without special chars passes through', () => {
      expect(toTelegramHtml('hello world')).toBe('hello world')
    })

    test('plain text with no markdown chars is unchanged', () => {
      expect(toTelegramHtml('just some plain text')).toBe('just some plain text')
    })

    test('escapes ampersand', () => {
      expect(toTelegramHtml('foo & bar')).toBe('foo &amp; bar')
    })

    test('escapes less-than and greater-than', () => {
      expect(toTelegramHtml('a < b > c')).toBe('a &lt; b &gt; c')
    })
  })

  describe('bold conversion', () => {
    test('converts **bold** to <b>bold</b>', () => {
      expect(toTelegramHtml('**hello world**')).toBe('<b>hello world</b>')
    })

    test('bold surrounded by plain text', () => {
      expect(toTelegramHtml('This is **bold** text.')).toBe('This is <b>bold</b> text.')
    })

    test('multiple bold segments', () => {
      expect(toTelegramHtml('**a** and **b**')).toBe('<b>a</b> and <b>b</b>')
    })

    test('escapes HTML chars inside bold', () => {
      expect(toTelegramHtml('**foo & bar**')).toBe('<b>foo &amp; bar</b>')
    })
  })

  describe('italic conversion', () => {
    test('converts *italic* to <i>italic</i>', () => {
      expect(toTelegramHtml('*italic*')).toBe('<i>italic</i>')
    })

    test('italic surrounded by plain text', () => {
      expect(toTelegramHtml('This is *italic* text.')).toBe('This is <i>italic</i> text.')
    })

    test('converts _italic_ (underscore style) to <i>italic</i>', () => {
      expect(toTelegramHtml('_italic_')).toBe('<i>italic</i>')
    })

    test('_italic_ surrounded by plain text', () => {
      expect(toTelegramHtml('This is _italic_ text.')).toBe('This is <i>italic</i> text.')
    })

    test('escapes HTML chars inside italic', () => {
      expect(toTelegramHtml('*foo & bar*')).toBe('<i>foo &amp; bar</i>')
    })
  })

  describe('inline code', () => {
    test('converts `code` to <code>code</code>', () => {
      expect(toTelegramHtml('Use `npm install`')).toBe('Use <code>npm install</code>')
    })

    test('escapes HTML chars inside inline code', () => {
      expect(toTelegramHtml('`a < b`')).toBe('<code>a &lt; b</code>')
    })
  })

  describe('code blocks', () => {
    test('converts ```block``` to <pre><code>block</code></pre>', () => {
      const input = '```typescript\nconst x = 1\n```'
      expect(toTelegramHtml(input)).toBe('<pre><code>const x = 1</code></pre>')
    })

    test('escapes HTML chars inside code block', () => {
      const input = '```\nfoo < bar & baz\n```'
      expect(toTelegramHtml(input)).toBe('<pre><code>foo &lt; bar &amp; baz</code></pre>')
    })

    test('code block without language', () => {
      const input = '```\nconst x = 1\n```'
      expect(toTelegramHtml(input)).toBe('<pre><code>const x = 1</code></pre>')
    })
  })

  describe('headers', () => {
    test('converts # header to <b>header</b>', () => {
      expect(toTelegramHtml('# My Title')).toBe('<b>My Title</b>')
    })

    test('converts ## header to <b>header</b>', () => {
      expect(toTelegramHtml('## Section')).toBe('<b>Section</b>')
    })

    test('escapes HTML chars in header', () => {
      expect(toTelegramHtml('# Hello & World')).toBe('<b>Hello &amp; World</b>')
    })
  })

  describe('links', () => {
    test('converts [text](url) to <a href="url">text</a>', () => {
      const result = toTelegramHtml('[Click here](https://example.com)')
      expect(result).toBe('<a href="https://example.com">Click here</a>')
    })

    test('escapes HTML chars in link text', () => {
      const result = toTelegramHtml('[foo & bar](https://example.com)')
      expect(result).toBe('<a href="https://example.com">foo &amp; bar</a>')
    })

    test('escapes HTML chars in URL', () => {
      const result = toTelegramHtml('[link](https://example.com?a=1&b=2)')
      expect(result).toBe('<a href="https://example.com?a=1&amp;b=2">link</a>')
    })
  })

  describe('table conversion', () => {
    test('wraps table in <pre> with aligned columns', () => {
      const input = '| A | B |\n|---|---|\n| 1 | 2 |'
      const result = toTelegramHtml(input)
      expect(result).toBe('<pre>| A | B |\n| - | - |\n| 1 | 2 |</pre>')
    })

    test('escapes HTML chars inside table', () => {
      const input = '| A & B | C |\n| 1 | 2 |'
      const result = toTelegramHtml(input)
      expect(result).toContain('&amp;')
      expect(result).toContain('<pre>')
    })

    test('table before and after text', () => {
      const input = 'Before\n| A | B |\n| 1 | 2 |\nAfter'
      const result = toTelegramHtml(input)
      expect(result).toContain('<pre>')
      expect(result).toContain('Before')
      expect(result).toContain('After')
    })
  })

  describe('bullet list conversion', () => {
    test('converts - item to bullet character', () => {
      expect(toTelegramHtml('- item one')).toBe('• item one')
    })

    test('converts multiple bullet items', () => {
      const result = toTelegramHtml('- item one\n- item two\n- item three')
      expect(result).toContain('• item one')
      expect(result).toContain('• item two')
      expect(result).toContain('• item three')
    })

    test('only converts line-start dash, not inline dash', () => {
      const result = toTelegramHtml('foo-bar\n- item')
      expect(result).toContain('• item')
      expect(result).toContain('foo-bar')
    })
  })

  describe('mixed content', () => {
    test('handles bold + code block + plain text', () => {
      const input = '**Title**\n\n```js\nconst x = 1\n```\n\nSome text.'
      const result = toTelegramHtml(input)
      expect(result).toContain('<b>Title</b>')
      expect(result).toContain('<pre><code>const x = 1</code></pre>')
      expect(result).toContain('Some text.')
    })

    test('planning-17 style output renders correctly', () => {
      const input = '**Planning 17 — Overview**\n\n- Point one\n- Point two\n\n`lastRecalledAt`'
      const result = toTelegramHtml(input)
      expect(result).toContain('<b>Planning 17')
      expect(result).toContain('<code>lastRecalledAt</code>')
      expect(result).toContain('• Point one')
    })
  })
})

describe('resolveTelegramReplyFormat() — agent-authored HTML must not render literally', () => {
  // Real payload shape from the reported bug: agent writes Telegram HTML tags
  // (<b>, <code>) with NO markdown tokens. Before the fix, auto-detect only
  // checked hasMarkdown() -> useHtml=false -> raw text, no parse_mode -> the
  // tags showed up literally in the chat.
  const htmlOnlyReport =
    '<b>Code review PR #2294 → commit <code>48060b3c</code></b>\n' +
    '12 files · <b>+52 / −196</b>\n' +
    '• verb <code>update</code> in <code>archive-backup-control.sh</code>'

  test('auto format: pure-HTML report is sent as HTML, tags preserved (regression)', () => {
    const { sendText, parseMode } = resolveTelegramReplyFormat(htmlOnlyReport)
    // Old behaviour returned parseMode=undefined here — this is the fail-on-old assertion.
    expect(parseMode).toBe('HTML')
    expect(sendText).toContain('<b>Code review PR #2294')
    expect(sendText).toContain('<code>48060b3c</code>')
    // never escaped into a literal tag
    expect(sendText).not.toContain('&lt;b&gt;')
  })

  test('auto format: markdown-only still routes to HTML', () => {
    const { parseMode } = resolveTelegramReplyFormat('This is **bold** and `code`')
    expect(parseMode).toBe('HTML')
  })

  test("explicit 'html' with already-valid tags is sent verbatim under HTML", () => {
    const { sendText, parseMode } = resolveTelegramReplyFormat('<b>hi</b>', 'html')
    expect(parseMode).toBe('HTML')
    expect(sendText).toBe('<b>hi</b>')
  })

  test("explicit 'text' is always raw with no parse_mode", () => {
    const { sendText, parseMode } = resolveTelegramReplyFormat(htmlOnlyReport, 'text')
    expect(parseMode).toBeUndefined()
    expect(sendText).toBe(htmlOnlyReport)
  })

  test('non-whitelist tags stay escaped even in auto HTML mode (safety)', () => {
    const { sendText, parseMode } = resolveTelegramReplyFormat('<b>ok</b> <script>alert(1)</script>')
    expect(parseMode).toBe('HTML')
    expect(sendText).toContain('<b>ok</b>')
    expect(sendText).toContain('&lt;script&gt;')
  })
})
