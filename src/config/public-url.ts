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

  const host = url.hostname.toLowerCase();
  const local =
    host === 'localhost' ||
    /^127\./.test(host) ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.internal') ||
    host.endsWith('.local');
  return local ? `${url.origin}/gateway` : null;
}
