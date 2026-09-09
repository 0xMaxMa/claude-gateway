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
 * A hard cut at `idx` (a UTF-16 code-unit index) can land between the two
 * code units of a surrogate pair (e.g. most emoji, which sit outside the
 * BMP) — splitting one across two chunks produces an unpaired surrogate in
 * each, which renders as U+FFFD / mojibake on the receiving side. Nudges
 * `idx` back by one so the pair stays together, unless doing so would leave
 * no room in this chunk at all (`idx <= minIdx`), in which case the split is
 * accepted rather than looping forever on an impossibly small budget.
 */
function avoidSurrogateSplit(text: string, idx: number, minIdx = 0): number {
  if (idx <= minIdx || idx >= text.length) return idx;
  const before = text.charCodeAt(idx - 1);
  const at = text.charCodeAt(idx);
  const isHighSurrogate = before >= 0xd800 && before <= 0xdbff;
  const isLowSurrogate = at >= 0xdc00 && at <= 0xdfff;
  if (isHighSurrogate && isLowSurrogate && idx - 1 > minIdx) return idx - 1;
  return idx;
}

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
 * Returns `[]` for empty input and `[text]` when it already fits. A hard cut
 * (either mode) never splits a surrogate pair — see avoidSurrogateSplit.
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
    let i = 0;
    while (i < text.length) {
      const end = avoidSurrogateSplit(text, Math.min(i + maxChars, text.length), i);
      chunks.push(text.slice(i, end));
      i = end;
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
    if (cut <= 0) cut = avoidSurrogateSplit(remaining, maxChars);
    const piece = remaining.slice(0, cut).replace(/\s+$/, '');
    // A cut that trims to nothing (a run of whitespace) would push an empty
    // bubble; skip it, but still advance `remaining` so the loop terminates.
    if (piece) chunks.push(piece);
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }

  return chunks;
}
