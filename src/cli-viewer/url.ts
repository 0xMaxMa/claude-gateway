/**
 * Build the absolute, phone-openable URL for a `/cli` webview from the operator-
 * configured `gateway.publicUrl`. Kept tiny and dependency-free so both the
 * runner callback (which mints pairings) and the gateway routes can share one
 * definition of "how a /cli link is formed".
 */

/** Trim and validate the configured public origin. Returns null when unusable
 *  (unset, blank, or not http(s)) so callers can report "not configured" rather
 *  than emit a broken link. Trailing slashes are stripped. */
export function normalizePublicUrl(publicUrl: string | undefined): string | null {
  const u = (publicUrl ?? '').trim().replace(/\/+$/, '');
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

/** Full viewer link for a pairing, or null when no public URL is configured. */
export function buildCliUrl(publicUrl: string | undefined, pairingId: string): string | null {
  const base = normalizePublicUrl(publicUrl);
  return base ? `${base}/cli/${pairingId}` : null;
}
