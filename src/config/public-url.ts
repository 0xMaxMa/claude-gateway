/**
 * Hosts for which plain `http:` is acceptable — a developer box, a container's own
 * network, a LAN appliance. Everywhere else, cleartext means the credential in the
 * request is readable in transit.
 *
 * Exported so connectors/mcp-oauth.ts applies the same rule to the OAuth endpoints it
 * discovers; two copies of this list would drift, and the second copy is the one that
 * would quietly keep allowing something this one had stopped allowing.
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    /^127\./.test(host) ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  );
}

/**
 * Validate and normalize the externally reachable gateway base URL.
 *
 * Production gateways live behind the /gateway Traefik prefix. Local Docker
 * E2E uses host.docker.internal but keeps the same prefix so minted share URLs
 * have one stable shape everywhere:
 *
 *   <gateway.publicUrl>/shared/<token>
 */
export function resolveGatewayPublicUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.search || url.hash || url.username || url.password) return null;

  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (pathname !== '/gateway') return null;

  if (url.protocol === 'https:') return `${url.origin}/gateway`;
  if (url.protocol !== 'http:') return null;

  return isLocalHostname(url.hostname) ? `${url.origin}/gateway` : null;
}
