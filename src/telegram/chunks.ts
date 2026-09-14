export const TELEGRAM_MAX_CHARS = 4096

/**
 * Telegram rejects a message whose HTML entities are unbalanced, so a chunk cut
 * that falls inside a <pre><code>…</code></pre> block must close the open tags
 * at the end of the chunk and reopen them at the start of the next one.
 * Reserve room for that worst-case suffix (</a></code></pre></b></i>) plus the
 * mirrored reopening prefix so balancing never pushes a chunk past the limit.
 */
const HTML_BALANCE_HEADROOM = 64

/** Tags toTelegramHtml() emits — the only ones balancing needs to understand. */
const BALANCED_TAGS = ['b', 'i', 'code', 'pre', 'a'] as const

/**
 * Scan an HTML fragment (as produced by toTelegramHtml — no attributes except
 * <a href>, no self-closing forms) and return the stack of tags still open at
 * the end, as full opening-tag strings in opening order.
 */
export function openTagStack(html: string): string[] {
  const stack: string[] = []
  // Attribute part tolerates '>' inside quoted values (<a href="a>b">).
  const re = /<(\/?)([a-z]+)((?:\s(?:"[^"]*"|[^>])*)?)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === '/'
    const name = m[2]
    if (!(BALANCED_TAGS as readonly string[]).includes(name)) continue
    if (closing) {
      // toTelegramHtml emits well-nested pairs, so the match is always the top.
      const top = stack.length - 1
      if (top >= 0 && /^<([a-z]+)/.exec(stack[top])?.[1] === name) stack.pop()
    } else {
      stack.push(`<${name}${m[3] ?? ''}>`)
    }
  }
  return stack
}

/** Strip Telegram-HTML tags and unescape entities → plain-text equivalent. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/&lt;br\s*\/?&gt;/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/**
 * Split text into chunks that fit within Telegram's message size limit.
 * Prefers paragraph → line → space boundaries over hard cuts.
 * When htmlSafe=true, avoids cutting inside an HTML tag (e.g. <code>, <b>) AND
 * keeps every chunk entity-balanced: tags left open at a cut are closed at the
 * chunk's end and reopened at the next chunk's start, so no chunk is ever
 * rejected by Telegram's HTML parser for an unclosed <pre>/<code>/<b>.
 */
export function chunkText(text: string, limit = TELEGRAM_MAX_CHARS, htmlSafe = false): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  const effLimit = htmlSafe ? limit - HTML_BALANCE_HEADROOM : limit
  // If cut lands inside an open tag (<...>), move cut to before the '<'
  const avoidMidTag = (cut: number): number => {
    const tagStart = rest.lastIndexOf('<', cut)
    const tagEnd = rest.lastIndexOf('>', cut)
    if (tagStart > tagEnd) cut = tagStart
    // Entity escapes and UTF-16 pairs are indivisible on the wire.
    const amp = rest.lastIndexOf('&', cut - 1)
    if (amp >= 0 && /^&(?:[a-zA-Z]+|#\d*|#x[0-9a-fA-F]*)$/.test(rest.slice(amp, cut))) cut = amp
    return cut
  }
  const closersFor = (open: string[]): string =>
    open.map((t) => `</${/^<([a-z]+)/.exec(t)![1]}>`).reverse().join('')
  // Cut at `cut`, balancing tags across the boundary when htmlSafe.
  const splitAt = (cut: number): { head: string; tail: string } => {
    if (cut > 0 && /[\uD800-\uDBFF]/.test(rest[cut - 1]) && /[\uDC00-\uDFFF]/.test(rest[cut] ?? '')) cut--
    let head = rest.slice(0, cut)
    let tail = rest.slice(cut).replace(/^\n+/, '')
    if (htmlSafe) {
      const open = openTagStack(head)
      if (open.length) {
        head += closersFor(open)
        tail = open.join('') + tail
      }
    }
    return { head, tail }
  }
  while (rest.length > effLimit) {
    const para = rest.lastIndexOf('\n\n', effLimit)
    const line = rest.lastIndexOf('\n', effLimit)
    const space = rest.lastIndexOf(' ', effLimit)
    let cut = para > effLimit / 2 ? para : line > effLimit / 2 ? line : space > 0 ? space : effLimit
    if (htmlSafe) cut = avoidMidTag(cut)
    let { head, tail } = splitAt(cut)
    // Forward-progress guard: when the chosen boundary sits right after an
    // opening tag (e.g. "<b> " + one unbroken >limit token), the reopened tag
    // prefix can re-add as much as the cut removed and `rest` never shrinks —
    // an infinite loop that would hang the whole receiver. Retry with a hard
    // cut at effLimit; if even that cannot shrink (degenerate tag-heavy input,
    // e.g. a single huge <a href>), emit the remainder as one oversized chunk
    // and stop — Telegram rejects it and the plain-text retry rescues the
    // content, which beats hanging the process.
    if (tail.length >= rest.length) {
      cut = htmlSafe ? avoidMidTag(effLimit) : effLimit
      ;({ head, tail } = splitAt(cut))
      if (tail.length >= rest.length) {
        out.push(rest)
        rest = ''
        break
      }
    }
    out.push(head)
    rest = tail
  }
  if (rest) out.push(rest)
  return out
}
