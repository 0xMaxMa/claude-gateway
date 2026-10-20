/**
 * Redirect policy shared by the connector proxy and the connector bridge (#635).
 * A same-origin redirect (a trailing-slash rewrite, a moved path) is followed with
 * the connector's headers, as Claude Code's own fetch-based transport did. A redirect
 * to any other origin is refused: the credential is never replayed somewhere the
 * connector config does not name. No imports: mcp/connector-bridge.ts loads the
 * compiled copy from dist/, and is bundled for Node inside app-agent containers.
 */
export const MAX_REDIRECTS = 5;

/** The redirect target when it stays on `from`'s origin; undefined otherwise. */
export function sameOriginRedirect(from: URL, location: string): URL | undefined {
  let next: URL;
  try { next = new URL(location, from); } catch { return undefined; }
  return next.origin === from.origin ? next : undefined;
}
