/**
 * Inbound-Host fallback for the gateway's own public base URL.
 *
 * Minted share URLs (`<base>/shared/<token>`) need the gateway's externally
 * reachable base. `gateway.publicUrl` supplies it when set, but pods provisioned
 * before that field was written at provision time (getpod #1939) never got it,
 * so image-to-image / image-to-video fail closed: the mint returns a token but
 * no `url`, and the media tools reject with "requires gateway.publicUrl".
 *
 * Rather than hand-edit every old pod, derive the base from the inbound request
 * the same way the LINE webhook already does: production pods sit behind Traefik,
 * whose routing rule pins the Host to the pod's own FQDN, so the Host header of a
 * real external request IS the gateway's public host. We persist it to a
 * gateway-level `.public-base` file (one host per pod, shared across agents) and
 * read it back at mint time whenever `gateway.publicUrl` is unset.
 *
 * Scheme is hardcoded `https`: the pod's Traefik `web-vm` entrypoint does NOT
 * trust forwarded headers, so `X-Forwarded-Proto` arrives as `http` (wrong)
 * while the Host is reliable — same reasoning as `src/api/line-webhook-router.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { IncomingHttpHeaders } from 'http';

/** host[:port] — letters, digits, dot, hyphen, colon. Mirrors line-webhook. */
const HOST_RE = /^[a-z0-9.\-:]+$/;

/** The gateway-level file, one directory above the agents root (i.e. the
 *  `.claude-gateway` home), so it is shared by every agent on the pod. */
function publicBaseFile(agentsRoot: string): string {
  return path.resolve(agentsRoot, '..', '.public-base');
}

/**
 * Extract a genuinely-external public host from an inbound request, or '' when
 * the request is not one we can trust as the pod's public FQDN.
 *
 * Prefers `X-Forwarded-Host` (set by Traefik) then falls back to `Host`. Rejects
 * loopback / internal / bare (dotless) hosts: those come from the MCP subprocess
 * (127.0.0.1), Docker health checks, or direct-IP hits and must never clobber
 * the real public host once it has been learned.
 */
export function externalHostFromHeaders(headers: IncomingHttpHeaders): string {
  const fwd = headers['x-forwarded-host'];
  const raw =
    (typeof fwd === 'string' ? fwd : Array.isArray(fwd) ? fwd[0] : '') ||
    (typeof headers.host === 'string' ? headers.host : '');
  const hostPort = (raw.split(',')[0] ?? '').trim().toLowerCase();
  if (!hostPort || !HOST_RE.test(hostPort)) return '';
  const hostname = hostPort.split(':')[0] ?? '';
  if (
    !hostname.includes('.') || // bare name (localhost, docker service names)
    hostname === 'localhost' ||
    /^127\./.test(hostname) ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local')
  ) {
    return '';
  }
  return hostPort;
}

/** In-process memo of the last value written per target file, so the common
 *  case (the same public host on every request) costs no disk I/O at all. */
const lastWritten = new Map<string, string>();

/**
 * Persist the pod's public base derived from a trusted external host. Best
 * effort and idempotent: only writes when the value changed (so it is cheap to
 * call on every request), writes atomically (temp + rename), and never throws —
 * a failure here must not break request handling.
 */
export function persistPublicBase(agentsRoot: string, host: string): void {
  const h = host.trim();
  if (!h || !HOST_RE.test(h)) return;
  const base = `https://${h}/gateway`;
  const target = publicBaseFile(agentsRoot);
  if (lastWritten.get(target) === base) return; // hot path: no syscall
  try {
    let current = '';
    try {
      current = fs.readFileSync(target, 'utf8');
    } catch {
      current = '';
    }
    if (current === base) {
      lastWritten.set(target, base);
      return;
    }
    const tmp = path.join(path.dirname(target), `.public-base.${process.pid}.tmp`);
    fs.writeFileSync(tmp, base, { mode: 0o600 });
    fs.renameSync(tmp, target);
    lastWritten.set(target, base);
  } catch {
    /* best-effort: never break the request path over a config-cache write */
  }
}

/** Read the persisted public base (`https://<host>/gateway`), or null. */
export function readPublicBase(agentsRoot: string): string | null {
  try {
    const v = fs.readFileSync(publicBaseFile(agentsRoot), 'utf8').trim().replace(/\/+$/, '');
    return v || null;
  } catch {
    return null;
  }
}
