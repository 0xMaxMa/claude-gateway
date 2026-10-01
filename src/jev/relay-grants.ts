/** Most bytes a relay grant list may take; larger replies are rejected unread. */
export const RELAY_GRANTS_MAX_BYTES = 262144;
/**
 * A relay's grant list, read with a byte cap while streaming (never buffered
 * whole first) and parsed without throwing raw SyntaxErrors. Any malformed
 * reply becomes the caller's own discovery code.
 */
export async function readRelayGrants(response: Response, invalid: string): Promise<any[]> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RELAY_GRANTS_MAX_BYTES) { void response.body?.cancel().catch(() => undefined); throw Error(invalid); }
  const reader = response.body?.getReader();
  if (!reader) throw Error(invalid);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > RELAY_GRANTS_MAX_BYTES) throw Error(invalid);
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  let body: any;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error(invalid); }
  if (!Array.isArray(body?.grants)) throw Error(invalid);
  return body.grants;
}
