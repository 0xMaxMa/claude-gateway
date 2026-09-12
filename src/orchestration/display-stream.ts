/** Extract only the display string from an incomplete flat speech JSON object.
 * Incomplete escapes/surrogate pairs are held until the next provider chunk. */
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
  space(); if (raw[i++] !== '{') return '';
  for (let fields = 0; fields < 2; fields++) {
    space(); const key = string(); if (!key?.complete) return '';
    space(); if (raw[i++] !== ':') return '';
    space(); const value = string(); if (!value) return '';
    if (key.text === 'display_text') return value.text;
    if (!value.complete) return '';
    space(); if (raw[i++] !== ',') return '';
  }
  return '';
}
