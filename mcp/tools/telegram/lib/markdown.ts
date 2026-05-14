/**
 * Markdown detection and conversion utilities for Telegram HTML mode.
 * Used by AgentRunner to auto-format agent output before forwarding.
 */

/**
 * Detects whether text contains markdown formatting patterns
 * that warrant HTML rendering in Telegram.
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
 * Escapes HTML special characters in plain text.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Escapes HTML special characters in a URL attribute value.
 */
function escapeHtmlAttr(url: string): string {
  return escapeHtml(url).replace(/"/g, '&quot;')
}

/**
 * Measures display width of a string, treating Thai/Unicode combining chars as 0-width.
 * Each base character counts as 1 column.
 */
function displayWidth(s: string): number {
  // Strip Unicode combining characters (Mn category) — these include Thai tone marks,
  // vowel signs above/below (U+0E31, U+0E34–U+0E3A, U+0E47–U+0E4E), and other combining marks
  const stripped = s.replace(/[\u0300-\u036F\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0E4F]/g, '')
  return stripped.length
}

/**
 * Pads a string on the right to reach the target display width.
 */
function padEnd(s: string, width: number): string {
  const pad = width - displayWidth(s)
  return pad > 0 ? s + ' '.repeat(pad) : s
}

/**
 * Splits a table row like `| a | b | c |` into trimmed cell strings.
 */
function splitCells(line: string): string[] {
  return line
    .replace(/^\s*\|\s*/, '')
    .replace(/\s*\|\s*$/, '')
    .split(/\s*\|\s*/)
}

/**
 * Returns true if the line is a separator row (e.g. |---|:---:|---:|)
 */
function isSeparator(line: string): boolean {
  return /^\s*\|[\s\-:|]+\|\s*$/.test(line)
}

/**
 * Aligns table columns by padding each cell to the widest value in its column.
 */
function formatTable(lines: string[]): string {
  const dataLines = lines.filter(l => !isSeparator(l))
  const rows = dataLines.map(splitCells)

  // Find column count
  const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0)

  // Compute max display width per column
  const colWidths: number[] = Array(colCount).fill(0)
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      colWidths[c] = Math.max(colWidths[c], displayWidth(row[c]))
    }
  }

  // Render rows
  const rendered = rows.map(row => {
    const cells = Array.from({ length: colCount }, (_, c) => padEnd(row[c] ?? '', colWidths[c]))
    return '| ' + cells.join(' | ') + ' |'
  })

  // Rebuild separator line from computed widths
  const sep = '| ' + colWidths.map(w => '-'.repeat(w)).join(' | ') + ' |'

  // Insert separator after header (first row)
  if (rendered.length > 1) {
    rendered.splice(1, 0, sep)
  }

  return rendered.join('\n')
}

/**
 * Converts standard Markdown to Telegram HTML format.
 *
 * Conversions:
 * - **bold** → <b>bold</b>
 * - *italic* / _italic_ → <i>italic</i>
 * - `code` → <code>code</code>
 * - ```block``` → <pre><code>block</code></pre>
 * - [text](url) → <a href="url">text</a>
 * - # Header → <b>Header</b>
 * - | table | → wrapped in <pre> (pipes preserved, monospace)
 * - - bullet → • bullet
 * - plain text → HTML-escaped (&amp; &lt; &gt;)
 */
export function toTelegramHtml(text: string): string {
  // Convert bullet lists first (line-level transform, safe as pre-pass)
  text = text.replace(/^- /gm, '• ')

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
        const code = nlIdx > 0 ? inner.slice(nlIdx + 1) : inner.replace(/^\n/, '')
        out.push('<pre><code>' + escapeHtml(code) + '</code></pre>')
        i = closeIdx + 4
        continue
      }
    }

    // Inline code `...` (not ```)
    if (text[i] === '`' && text[i + 1] !== '`') {
      const closeIdx = text.indexOf('`', i + 1)
      if (closeIdx !== -1) {
        out.push('<code>' + escapeHtml(text.slice(i + 1, closeIdx)) + '</code>')
        i = closeIdx + 1
        continue
      }
    }

    // Bold **...**
    if (text.startsWith('**', i) && text[i + 2] !== '*' && text[i + 2] !== ' ') {
      const closeIdx = text.indexOf('**', i + 2)
      if (closeIdx !== -1 && !text.slice(i + 2, closeIdx).includes('\n')) {
        out.push('<b>' + escapeHtml(text.slice(i + 2, closeIdx)) + '</b>')
        i = closeIdx + 2
        continue
      }
    }

    // Italic *...* (single asterisk, not bold)
    if (text[i] === '*' && text[i + 1] !== '*' && text[i + 1] !== ' ' && text[i + 1] !== undefined) {
      const closeIdx = text.indexOf('*', i + 1)
      if (closeIdx !== -1 && !text.slice(i + 1, closeIdx).includes('\n')) {
        out.push('<i>' + escapeHtml(text.slice(i + 1, closeIdx)) + '</i>')
        i = closeIdx + 1
        continue
      }
    }

    // Italic _..._ (underscore style)
    if (text[i] === '_' && text[i + 1] !== '_' && text[i + 1] !== ' ' && text[i + 1] !== undefined) {
      const closeIdx = text.indexOf('_', i + 1)
      if (closeIdx !== -1 && !text.slice(i + 1, closeIdx).includes('\n')) {
        out.push('<i>' + escapeHtml(text.slice(i + 1, closeIdx)) + '</i>')
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
          out.push('<a href="' + escapeHtmlAttr(url) + '">' + escapeHtml(linkText) + '</a>')
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
        out.push('<b>' + escapeHtml(text.slice(i + level + 1, end)) + '</b>')
        i = end
        continue
      }
    }

    // Table lines starting with | at line start → collect, align columns, wrap in <pre>
    if ((i === 0 || text[i - 1] === '\n') && text[i] === '|') {
      const tableLines: string[] = []
      let j = i
      while (j < len) {
        const lineEnd = text.indexOf('\n', j)
        const end = lineEnd === -1 ? len : lineEnd
        const line = text.slice(j, end)
        if (/^\s*\|.*\|\s*$/.test(line)) {
          tableLines.push(line)
          j = lineEnd === -1 ? len : lineEnd + 1
          if (lineEnd === -1) break
        } else {
          break
        }
      }
      if (tableLines.length > 0) {
        out.push('<pre>' + escapeHtml(formatTable(tableLines)) + '</pre>')
        i = j
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
        (c === '#' && (j === 0 || text[j - 1] === '\n')) ||
        (c === '|' && (j === 0 || text[j - 1] === '\n'))
      ) break
      j++
    }
    out.push(escapeHtml(text.slice(i, j)))
    i = j
  }

  return out.join('')
}
