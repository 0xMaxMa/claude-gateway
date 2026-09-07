/**
 * Channel-agnostic text chunker.
 *
 * Modeled on `src/agent/line-pure.ts`'s `splitForLine` (same paragraph →
 * newline → space cut-point preference) but WITHOUT LINE's two
 * platform-specific behaviours:
 *
 *  - No 5-bubble cap. LINE can only carry 5 message objects per reply/push
 *    call, so `splitForLine` stops after 5 chunks and truncates. WhatsApp has
 *    no such per-request limit (each chunk is its own API call / socket send),
 *    so this keeps splitting until the whole text is emitted.
 *  - No ellipsis/truncation. Nothing is ever dropped — the concatenation of
 *    the returned chunks is the input, modulo whitespace collapsed exactly at
 *    the cut points.
 *
 * Used by both WhatsApp channels (Cloud API's 4096-char text limit, Baileys'
 * conservative 4000) and safe for any other channel that needs plain splitting.
 */

/**
 * Split `text` into chunks of at most `maxChars` characters.
 *
 * `mode`:
 *  - `'newline'` (default) — prefer to break on the last paragraph break,
 *    then the last newline, then the last space that falls inside the budget,
 *    so chunks end at a natural boundary. Whitespace at a cut point is
 *    trimmed (it would otherwise show up as a leading blank line on the next
 *    message bubble). Falls back to a hard cut when no boundary sits late
 *    enough in the budget to be worth using.
 *  - `'length'` — hard cut at exactly `maxChars`, no boundary search and no
 *    whitespace trimming. For callers whose limit is a strict byte/char
 *    budget where losing a space would matter.
 *
 * Returns `[]` for empty input and `[text]` when it already fits.
 */
export function chunkText(
  text: string,
  maxChars: number,
  mode: 'length' | 'newline' = 'newline',
): string[] {
  if (!text) return [];
  // A non-positive budget can never make progress — treat it as "no split"
  // rather than looping forever.
  if (!Number.isFinite(maxChars) || maxChars < 1) return [text];
  if (text.length <= maxChars) return [text];

  if (mode === 'length') {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) {
      chunks.push(text.slice(i, i + maxChars));
    }
    return chunks;
  }

  const chunks: string[] = [];
  let remaining = text;
  // Only accept a boundary in the LATER half of the budget: an earlier one
  // wastes so much of the chunk that it produces more messages than the text
  // needs (same heuristic splitForLine uses).
  const half = Math.floor(maxChars * 0.5);

  while (remaining) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf('\n\n', maxChars);
    if (cut < half) cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < half) cut = remaining.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars;
    const piece = remaining.slice(0, cut).replace(/\s+$/, '');
    // A cut that trims to nothing (a run of whitespace) would push an empty
    // bubble; skip it, but still advance `remaining` so the loop terminates.
    if (piece) chunks.push(piece);
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }

  return chunks;
}
