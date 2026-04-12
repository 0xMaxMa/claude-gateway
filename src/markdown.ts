/**
 * Markdown detection and conversion utilities for Telegram MarkdownV2.
 * Used by AgentRunner to auto-format agent output before forwarding.
 */

/**
 * Detects whether text contains markdown formatting patterns
 * that warrant MarkdownV2 rendering in Telegram.
 */
export function hasMarkdown(text: string): boolean {
  return (
    /\*\*[^*\n]+\*\*/m.test(text) ||          // **bold**
    /\*[^\s*\n][^*\n]*\*/m.test(text) ||       // *italic*
    /_[^\s_\n][^_\n]*_/m.test(text) ||        // _italic_
    /`[^`\n]+`/m.test(text) ||                 // `inline code`
    /^```/m.test(text) ||                      // ```code block
    /^#{1,6}\s/m.test(text) ||                 // # header
    /^\|.+\|/m.test(text) ||                   // | table row |
    /^- /m.test(text) ||                       // - bullet list
    /\[.+?\]\(https?:\/\/.+?\)/m.test(text)   // [link](url)
  )
}

/**
 * Escapes all MarkdownV2 special characters in a plain text segment.
 */
function escapePlain(text: string): string {
  return text.replace(/([_*[\]()~`>#+=|{}.!\-\\])/g, '\\$1')
}

/**
 * Converts Markdown bullet list lines (- item) to bullet character (• item).
 * Telegram MarkdownV2 does not support native bullet lists.
 */
function convertBulletLists(text: string): string {
  return text.replace(/^- /gm, '• ')
}

/**
 * Converts consecutive Markdown table lines to an aligned monospace code block.
 * Renders without | delimiters — columns are padded with spaces, header separated by dashes.
 * Telegram does not support native tables — code blocks preserve alignment.
 */
function convertTablesToCodeBlocks(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let tableLines: string[] = []

  const isSeparatorRow = (line: string): boolean =>
    /^\s*\|[-:\s|]+\|\s*$/.test(line) && line.includes('---')

  const parseRow = (line: string): string[] =>
    line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())

  const flushTable = (): void => {
    if (tableLines.length === 0) return

    const rows = tableLines.filter(l => !isSeparatorRow(l)).map(parseRow)
    if (rows.length === 0) {
      tableLines = []
      return
    }

    const colCount = Math.max(...rows.map(r => r.length))
    const colWidths: number[] = Array(colCount).fill(0)
    for (const row of rows) {
      for (let c = 0; c < row.length; c++) {
        colWidths[c] = Math.max(colWidths[c], row[c].length)
      }
    }

    const padRow = (row: string[]): string =>
      row.map((cell, c) => c < colCount - 1 ? cell.padEnd(colWidths[c]) : cell).join('  ')

    const totalWidth = colWidths.reduce((sum, w, i) => sum + w + (i < colCount - 1 ? 2 : 0), 0)
    const separator = '-'.repeat(totalWidth)
    const formatted = [padRow(rows[0]), separator, ...rows.slice(1).map(padRow)]

    out.push('```', ...formatted, '```')
    tableLines = []
  }

  for (const line of lines) {
    const isTableLine = /^\s*\|.*\|\s*$/.test(line)
    if (isTableLine) {
      tableLines.push(line)
    } else {
      flushTable()
      out.push(line)
    }
  }
  flushTable()
  return out.join('\n')
}

/**
 * Converts standard Markdown to Telegram MarkdownV2 format.
 *
 * Conversions:
 * - **bold** → *bold*
 * - `code` → `code` (inner chars escaped)
 * - ```block``` → ```block``` (inner chars escaped)
 * - [text](url) → [text](url) (properly escaped)
 * - # Header → *Header* (bold)
 * - | table | → wrapped in code block
 * - plain text → all special chars escaped
 */
export function toMarkdownV2(text: string): string {
  text = convertBulletLists(text)
  text = convertTablesToCodeBlocks(text)

  const out: string[] = []
  let i = 0
  const len = text.length

  while (i < len) {
    // Triple backtick code block: ```[lang]\n...\n```
    if (text.startsWith('```', i)) {
      const closeIdx = text.indexOf('\n```', i + 3)
      if (closeIdx !== -1) {
        const inner = text.slice(i + 3, closeIdx)
        const nlIdx = inner.indexOf('\n')
        // nlIdx > 0 means there's a language tag before the first newline
        const lang = nlIdx > 0 ? inner.slice(0, nlIdx) : ''
        const code = nlIdx > 0 ? inner.slice(nlIdx + 1) : inner.replace(/^\n/, '')
        const esc = code.replace(/\\/g, '\\\\').replace(/`/g, '\\`')
        out.push('```' + lang + '\n' + esc + '\n```')
        i = closeIdx + 4
        continue
      }
    }

    // Inline code `...` (not ```)
    if (text[i] === '`' && text[i + 1] !== '`') {
      const closeIdx = text.indexOf('`', i + 1)
      if (closeIdx !== -1) {
        const code = text.slice(i + 1, closeIdx)
        const esc = code.replace(/\\/g, '\\\\').replace(/`/g, '\\`')
        out.push('`' + esc + '`')
        i = closeIdx + 1
        continue
      }
    }

    // Bold **...** (single-line only)
    if (text.startsWith('**', i) && text[i + 2] !== '*' && text[i + 2] !== ' ') {
      const closeIdx = text.indexOf('**', i + 2)
      if (closeIdx !== -1 && !text.slice(i + 2, closeIdx).includes('\n')) {
        out.push('*' + escapePlain(text.slice(i + 2, closeIdx)) + '*')
        i = closeIdx + 2
        continue
      }
    }

    // Italic *...* (single asterisk, not bold)
    if (text[i] === '*' && text[i + 1] !== '*' && text[i + 1] !== ' ' && text[i + 1] !== undefined) {
      const closeIdx = text.indexOf('*', i + 1)
      if (closeIdx !== -1 && !text.slice(i + 1, closeIdx).includes('\n')) {
        out.push('_' + escapePlain(text.slice(i + 1, closeIdx)) + '_')
        i = closeIdx + 1
        continue
      }
    }

    // Italic _..._ (underscore style)
    if (text[i] === '_' && text[i + 1] !== '_' && text[i + 1] !== ' ' && text[i + 1] !== undefined) {
      const closeIdx = text.indexOf('_', i + 1)
      if (closeIdx !== -1 && !text.slice(i + 1, closeIdx).includes('\n')) {
        out.push('_' + escapePlain(text.slice(i + 1, closeIdx)) + '_')
        i = closeIdx + 1
        continue
      }
    }

    // Link [text](url)
    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1)
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          const linkText = text.slice(i + 1, closeBracket)
          const url = text.slice(closeBracket + 2, closeParen)
          const escapedUrl = url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)')
          out.push('[' + escapePlain(linkText) + '](' + escapedUrl + ')')
          i = closeParen + 1
          continue
        }
      }
    }

    // Header # at start of line → bold
    if ((i === 0 || text[i - 1] === '\n') && text[i] === '#') {
      let level = 0
      while (i + level < len && text[i + level] === '#') level++
      if (level <= 6 && text[i + level] === ' ') {
        const lineEnd = text.indexOf('\n', i + level + 1)
        const end = lineEnd === -1 ? len : lineEnd
        const headerText = text.slice(i + level + 1, end)
        out.push('*' + escapePlain(headerText) + '*')
        i = end
        continue
      }
    }

    // Accumulate plain text until next markdown token
    let j = i + 1
    while (j < len) {
      const c = text[j]
      if (
        text.startsWith('```', j) ||
        (c === '`' && text[j + 1] !== '`') ||
        text.startsWith('**', j) ||
        (c === '*' && text[j + 1] !== '*' && text[j + 1] !== ' ') ||
        (c === '_' && text[j + 1] !== '_' && text[j + 1] !== ' ') ||
        c === '[' ||
        (c === '#' && (j === 0 || text[j - 1] === '\n'))
      ) break
      j++
    }
    out.push(escapePlain(text.slice(i, j)))
    i = j
  }

  return out.join('')
}
