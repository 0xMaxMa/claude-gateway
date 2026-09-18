/** Extract only the display string from an incomplete flat response JSON object.
 * Incomplete escapes/surrogate pairs are held until the next provider chunk.
 * Other fields of the union response schema (spoken_text, notify_user) are skipped
 * without ever being published, whatever order the model emits them in. */
export function partialDisplay(raw: string): string {
  let i = 0;
  const space = () => { while (/\s/.test(raw[i] ?? '') && i < raw.length) i++; };
  const string = (): { text: string; complete: boolean } | undefined => {
    if (raw[i++] !== '"') return;
    let text = '';
    let encoded = '';
    while (i < raw.length) {
      encoded = '';
      const ch = raw[i++];
      if (ch === '"') return { text, complete: true };
      if (ch === '\\') {
        const escape = raw[i++];
        if (!escape) break;
        if (escape === 'u') {
          const hex = raw.slice(i, i + 4);
          if (!/^[0-9a-f]{4}$/i.test(hex)) break;
          encoded += '\\u' + hex; i += 4;
        } else if ('"\\/bfnrt'.includes(escape)) encoded += '\\' + escape;
        else return;
      } else {
        if (ch.charCodeAt(0) < 32) return;
        encoded += ch;
      }
      try { text += JSON.parse('"' + encoded + '"'); } catch { return; }
    }
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return { text, complete: false };
  };
  // true/false/null/number values (notify_user) carry no display text; skip a complete
  // one, and hold the chunk while it is still arriving so position stays trustworthy.
  const literal = (): boolean => {
    const match = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[\s,}])/.exec(raw.slice(i));
    if (!match) return false;
    i += match[0].length; return true;
  };
  space(); if (raw[i++] !== '{') return '';
  // One pass per union field; an unexpected shape simply holds the chunk back.
  for (let fields = 0; fields < 8; fields++) {
    space(); const key = string(); if (!key?.complete) return '';
    space(); if (raw[i++] !== ':') return '';
    space();
    if (key.text === 'display_text') return string()?.text ?? '';
    if (!(raw[i] === '"' ? string()?.complete : literal())) return '';
    space(); if (raw[i++] !== ',') return '';
  }
  return '';
}

/** An object opening with one of the union response schema's own field names. Ordinary
 * replies contain braces and fenced code blocks legitimately, so only this shape counts
 * as our payload; anything looser would hold back or mangle real answers. */
const UNION_KEYS = ['display_text', 'spoken_text', 'notify_user'];
const PAYLOAD_OBJECT = /\{\s*"(?:display_text|spoken_text|notify_user)"\s*:/;

/** `index` moved back over the opening fence that announces the object there, if any: a
 * fenced payload is announced by its fence, so the fence belongs to the payload rather than
 * being left behind as stray markdown. */
export function fenceAdjusted(raw: string, index: number): number {
  const fence = /```(?:json)?[ \t]*\r?\n?$/.exec(raw.slice(0, index));
  return fence ? fence.index : index;
}

/** Index at which the first union-schema payload starts inside otherwise plain text, or -1. */
export function payloadStart(raw: string): number {
  const match = PAYLOAD_OBJECT.exec(raw);
  return match ? fenceAdjusted(raw, match.index) : -1;
}

/** The incremental text safe to publish for a partial agent turn.
 *
 * The union response schema is declared on every turn, so the dominant case is a
 * StructuredOutput argument stream and only display_text may be shown. The model may
 * still answer in plain text (the CLI never forces the tool), and that text is the reply
 * itself — publish it as it arrives, exactly as before the schema became invariant.
 * Anything that opens like an object or a fenced block is treated as structured and held
 * until display_text is parseable, so raw JSON is never shown to the user. A turn that
 * opens with prose and only then emits its payload is the same leak one token later: the
 * prose streams, but everything from the payload on is withheld for the final parse. */
export function displayPrefix(raw: string): string {
  if (/^\s*[{`]/.test(raw)) return partialDisplay(raw);
  const start = payloadStart(raw);
  if (start >= 0) return raw.slice(0, start);
  // The opener arrives a character at a time, so an object whose key is still being typed
  // must be held too — otherwise `{"display_text"` publishes before the colon identifies it.
  // Only a key that can still become a union field holds; braces in ordinary prose (and the
  // JSON a user actually asked for) keep streaming.
  const opening = /\{\s*(?:"([a-z_]*)"?\s*:?)?$/.exec(raw);
  const typed = opening?.[1] ?? '';
  return opening && UNION_KEYS.some(key => key.startsWith(typed)) ? raw.slice(0, opening.index) : raw;
}
