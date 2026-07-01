/**
 * Pure, dependency-free LINE text helpers used by the gateway-side
 * LineReplyManager (src/agent/line-reply-manager.ts).
 *
 * These mirror the chunking the MCP `line_reply` tool does in
 * mcp/tools/line/pure.ts, but live under src/ because tsc's rootDir is ./src —
 * src cannot import from mcp/. Ported from hermes-agent
 * plugins/platforms/line/adapter.py (strip_markdown_preserving_urls /
 * split_for_line, PR #18153).
 */

/** LINE hard limit: max message objects per push/reply request. */
export const LINE_MAX_MESSAGES_PER_REQUEST = 5;
/** Conservative per-bubble char budget for chunking (below the 5000 hard limit). */
export const LINE_SAFE_BUBBLE_CHARS = 4500;

// Markdown patterns LINE's text bubble can't render.
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const MD_BOLD_RE = /\*\*([\s\S]+?)\*\*/g;
const MD_ITALIC_RE = /(?<!\*)\*(?!\s)([\s\S]+?)(?<!\s)\*(?!\*)/g;
const MD_CODE_INLINE_RE = /`([^`]+)`/g;
const MD_CODE_BLOCK_RE = /```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g;
const MD_HEADING_RE = /^#{1,6}\s+/gm;
const MD_BULLET_RE = /^[ \t]*[-*+]\s+/gm;

/**
 * Strip Markdown that LINE can't render, but keep URLs tappable.
 *
 * LINE's text bubble has zero Markdown support; bare URLs auto-link but
 * `[label](url)` does not. So convert links to `label (url)`, keep code-block
 * and inline-code *content* (drop the fences/backticks), and strip bold/italic/
 * heading/bullet markers. Port of hermes `strip_markdown_preserving_urls`.
 */
export function stripMarkdownPreservingUrls(text: string): string {
  if (!text) return text;
  let t = text;
  // Code blocks first — keep inner content, drop the fences.
  t = t.replace(MD_CODE_BLOCK_RE, (_m, inner: string) => inner.replace(/\n+$/, ''));
  // Inline code: keep content, drop backticks.
  t = t.replace(MD_CODE_INLINE_RE, '$1');
  // Markdown links → "label (url)".
  t = t.replace(MD_LINK_RE, (_m, label: string, url: string) => `${label} (${url})`);
  // Bold/italic markers — strip.
  t = t.replace(MD_BOLD_RE, '$1');
  t = t.replace(MD_ITALIC_RE, '$1');
  // Headings + bullet markers — strip the prefix only.
  t = t.replace(MD_HEADING_RE, '');
  t = t.replace(MD_BULLET_RE, '• ');
  return t;
}

/**
 * Split text into LINE-sized bubbles, preferring paragraph/line/space breaks.
 * Returns at most LINE_MAX_MESSAGES_PER_REQUEST chunks; overflow truncates the
 * final chunk with an ellipsis (so the whole reply fits one Reply/Push call).
 * Port of hermes `split_for_line`.
 */
export function splitForLine(text: string, maxChars = LINE_SAFE_BUBBLE_CHARS): string[] {
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;
  const half = Math.floor(maxChars * 0.5);
  while (remaining && chunks.length < LINE_MAX_MESSAGES_PER_REQUEST) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      remaining = '';
      break;
    }
    // Break on the latest paragraph, then newline, then space within budget.
    let cut = remaining.lastIndexOf('\n\n', maxChars);
    if (cut < half) cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < half) cut = remaining.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars;
    chunks.push(remaining.slice(0, cut).replace(/\s+$/, ''));
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }

  if (remaining) {
    // Truncate gracefully — the 5-bubble budget is spent.
    if (chunks.length > 0) {
      let tail = chunks[chunks.length - 1];
      if (tail.length > maxChars - 1) tail = tail.slice(0, maxChars - 1);
      chunks[chunks.length - 1] = tail.replace(/\s+$/, '') + '…';
    } else {
      chunks.push(remaining.slice(0, maxChars - 1) + '…');
    }
  }
  return chunks;
}
