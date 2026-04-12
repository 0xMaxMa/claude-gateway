/**
 * Unit tests for hasMarkdown() and toMarkdownV2() from plugins/telegram/pure.ts
 */
import { hasMarkdown, toMarkdownV2 } from '../../../src/markdown'
import { hasMarkdown as hasMarkdownPure, toMarkdownV2 as toMarkdownV2Pure } from '../../../plugins/telegram/pure'

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
})

describe('toMarkdownV2()', () => {
  describe('plain text escaping', () => {
    test('escapes special chars in plain text', () => {
      expect(toMarkdownV2('hello. world!')).toBe('hello\\. world\\!')
    })

    test('escapes dash and underscore', () => {
      expect(toMarkdownV2('foo-bar_baz')).toBe('foo\\-bar\\_baz')
    })

    test('escapes parentheses and brackets', () => {
      expect(toMarkdownV2('(test) [value]')).toBe('\\(test\\) \\[value\\]')
    })

    test('simple text without special chars passes through', () => {
      expect(toMarkdownV2('hello world')).toBe('hello world')
    })
  })

  describe('bold conversion', () => {
    test('converts **bold** to *bold* with content escaped', () => {
      expect(toMarkdownV2('**hello world**')).toBe('*hello world*')
    })

    test('escapes special chars inside bold', () => {
      expect(toMarkdownV2('**foo.bar**')).toBe('*foo\\.bar*')
    })

    test('bold surrounded by plain text', () => {
      expect(toMarkdownV2('This is **bold** text.')).toBe('This is *bold* text\\.')
    })

    test('multiple bold segments', () => {
      expect(toMarkdownV2('**a** and **b**')).toBe('*a* and *b*')
    })
  })

  describe('inline code', () => {
    test('preserves inline code', () => {
      expect(toMarkdownV2('Use `npm install`')).toBe('Use `npm install`')
    })

    test('passes through inline code content unchanged (only \\ and ` escaped)', () => {
      // Input: `hello world` — no special escaping needed
      expect(toMarkdownV2('`hello world`')).toBe('`hello world`')
    })
  })

  describe('code blocks', () => {
    test('preserves code block with language', () => {
      const input = '```typescript\nconst x = 1\n```'
      const result = toMarkdownV2(input)
      expect(result).toBe('```typescript\nconst x = 1\n```')
    })

    test('escapes special chars inside code block content', () => {
      const input = '```\nfoo.bar()\n```'
      const result = toMarkdownV2(input)
      // Only \ and ` are escaped in code blocks, not . or ()
      expect(result).toBe('```\nfoo.bar()\n```')
    })
  })

  describe('headers', () => {
    test('converts # header to *bold*', () => {
      expect(toMarkdownV2('# My Title')).toBe('*My Title*')
    })

    test('converts ## header to *bold*', () => {
      expect(toMarkdownV2('## Section')).toBe('*Section*')
    })

    test('escapes special chars in header', () => {
      expect(toMarkdownV2('# Hello World!')).toBe('*Hello World\\!*')
    })
  })

  describe('links', () => {
    test('converts [text](url) link — URL only escapes ) and \\', () => {
      // Telegram MarkdownV2: URL part only requires ) and \ escaped
      const result = toMarkdownV2('[Click here](https://example.com)')
      expect(result).toBe('[Click here](https://example.com)')
    })

    test('escapes special chars in link text but not in URL', () => {
      const result = toMarkdownV2('[foo.bar](https://example.com)')
      expect(result).toBe('[foo\\.bar](https://example.com)')
    })
  })

  describe('table conversion', () => {
    test('wraps table in code block', () => {
      const input = '| A | B |\n|---|---|\n| 1 | 2 |'
      const result = toMarkdownV2(input)
      expect(result).toContain('```')
      expect(result).toContain('| A | B |')
      expect(result).toContain('| 1 | 2 |')
    })

    test('table before and after text', () => {
      const input = 'Before\n| A | B |\n| 1 | 2 |\nAfter'
      const result = toMarkdownV2(input)
      expect(result).toContain('```')
      expect(result).toContain('Before')
      expect(result).toContain('After')
    })
  })

  describe('mixed content', () => {
    test('handles bold + code block + plain text', () => {
      const input = '**Title**\n\n```js\nconst x = 1\n```\n\nSome text.'
      const result = toMarkdownV2(input)
      expect(result).toContain('*Title*')
      expect(result).toContain('```js')
      expect(result).toContain('const x = 1')
      expect(result).toContain('Some text\\.')
    })

    test('planning-17 style output renders correctly', () => {
      const input = '**Planning 17 — Overview**\n\n- Point one\n- Point two\n\n`lastRecalledAt`'
      const result = toMarkdownV2(input)
      expect(result).toContain('*Planning 17')
      expect(result).toContain('`lastRecalledAt`')
    })
  })
})

describe('plugins/telegram/pure hasMarkdown() and toMarkdownV2()', () => {
  test('hasMarkdown detects **bold**', () => {
    expect(hasMarkdownPure('**bold**')).toBe(true)
  })

  test('hasMarkdown detects inline code', () => {
    expect(hasMarkdownPure('`code`')).toBe(true)
  })

  test('hasMarkdown plain text returns false', () => {
    expect(hasMarkdownPure('just text')).toBe(false)
  })

  test('toMarkdownV2 converts **bold**', () => {
    expect(toMarkdownV2Pure('**hello**')).toBe('*hello*')
  })

  test('toMarkdownV2 escapes plain text special chars', () => {
    expect(toMarkdownV2Pure('hello. world!')).toBe('hello\\. world\\!')
  })

  test('toMarkdownV2 preserves inline code', () => {
    expect(toMarkdownV2Pure('Use `npm install`')).toBe('Use `npm install`')
  })

  test('pure and src produce identical output for complex input', () => {
    const input = '**Title**\n\n```ts\nconst x = 1\n```\n\nSome `code` here.'
    expect(toMarkdownV2Pure(input)).toBe(toMarkdownV2(input))
  })
})
