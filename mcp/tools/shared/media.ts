/**
 * Media-download/poll helpers shared by the image and video MCP tool modules.
 * Self-contained on purpose, like share-client.ts: mcp/** ships as source
 * without src/**, so this module must not import from src/ (see
 * tests/unit/mcp-no-src-imports.test.ts).
 */

// Resolves early (without rejecting) on abort — a poll loop re-checks
// signal.aborted itself right after, so this only needs to shorten the wait.
// The abort listener is removed when the timer fires normally: sleep() is called
// once per poll iteration against the SAME long-lived signal (up to dozens of
// times for a multi-minute poll budget), so leaving { once: true } listeners
// around on the non-abort path would pile them onto that one signal and trip
// Node's MaxListenersExceededWarning.
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((r) => {
    const onAbort = () => { clearTimeout(t); r(); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); r(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'default';
}

// Read a response body into a Buffer with a hard byte ceiling: reject early on a
// too-large Content-Length, and stream-count actual bytes so a chunked response
// without Content-Length can't blow past the cap (OOM guard). `label` (e.g.
// "image"/"video") only shapes the error message.
export async function readCapped(res: Response, cap: number, label = 'file'): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error(`download ${label} too large: ${declared} bytes (max ${cap})`);
  }
  if (!res.body) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > cap) throw new Error(`download ${label} too large (max ${cap} bytes)`);
    return Buffer.from(ab);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > cap) throw new Error(`download ${label} exceeded ${cap} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// https is required for a PUBLIC endpoint (a Bearer proxy_secret is sent on
// every call); http is tolerated only for a local/internal host — a trusted hop
// such as host.docker.internal in dev, where cleartext never leaves the network.
export function baseUrlIsSecure(raw: string): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h === 'host.docker.internal' ||
    h.endsWith('.internal') ||
    h.endsWith('.local') ||
    /^127\./.test(h) ||
    h === '::1' ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)
  );
}
