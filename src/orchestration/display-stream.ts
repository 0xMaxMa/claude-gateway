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

/** The incremental text safe to publish for a partial agent turn.
 *
 * The union response schema is declared on every turn, so the dominant case is a
 * StructuredOutput argument stream and only display_text may be shown. The model may
 * still answer in plain text (the CLI never forces the tool), and that text is the reply
 * itself — publish it as it arrives, exactly as before the schema became invariant.
 * Anything that opens like an object or a fenced block is treated as structured and held
 * until display_text is parseable, so raw JSON is never shown to the user. */
export function displayPrefix(raw: string): string {
  return /^\s*[{`]/.test(raw) ? partialDisplay(raw) : raw;
}
