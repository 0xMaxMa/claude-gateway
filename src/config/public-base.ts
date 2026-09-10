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
 * the same way the LINE webhook already does: production pods sit behind a
 * reverse proxy (Traefik) whose routing rule pins the Host to the pod's own
 * FQDN, so the Host header of a real external request IS the gateway's public
 * host. We persist it to a gateway-level `.public-base` file (one host per pod,
 * shared across agents) and read it back at mint time whenever `gateway.publicUrl`
 * is unset.
 *
 * SECURITY — why the trusted-proxy gate exists.
 * `X-Forwarded-Host` / `Host` are client-controllable. `claude-gateway` is a
 * general-purpose open-source project: anyone can self-host it directly on the
 * internet, or behind a proxy that does not strip these headers. If we learned
 * the public host from any request, an attacker could send
 * `X-Forwarded-Host: evil.com` and poison the pod-wide base URL — every share
 * link minted afterward would point at their domain (phishing / URL confusion),
 * for every agent on the box. So learning is **fail-safe-off**: we only trust
 * forwarding headers when the request's *immediate TCP peer*
 * (`socket.remoteAddress`) is in an operator-configured `gateway.trustedProxies`
 * allowlist (IPs / CIDRs / the presets loopback|linklocal|uniquelocal|private),
 * analogous to Express's `trust proxy`. Unset / empty allowlist = never learn
 * from headers; the operator sets `gateway.publicUrl` explicitly instead. getpod
 * pods opt in by trusting their Traefik hop, so the fallback heals them without a
 * per-pod edit while a bare self-host stays safe by default.
 *
 * Scheme is hardcoded `https`: the pod's Traefik `web-vm` entrypoint does NOT
 * trust forwarded headers, so `X-Forwarded-Proto` arrives as `http` (wrong)
 * while the Host is reliable — same reasoning as `src/api/line-webhook-router.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import type { IncomingHttpHeaders } from 'http';

/** host[:port] — letters, digits, dot, hyphen, colon. Mirrors line-webhook. */
const HOST_RE = /^[a-z0-9.\-:]+$/;

/** The gateway-level file, one directory above the agents root (i.e. the
 *  `.claude-gateway` home), so it is shared by every agent on the pod. */
function publicBaseFile(agentsRoot: string): string {
  return path.resolve(agentsRoot, '..', '.public-base');
}

/** Named CIDR presets, mirroring Express `trust proxy`. `private` is the
 *  convenience union (loopback + linklocal + uniquelocal) — the common case for
 *  a reverse proxy co-located with the gateway on a private/Docker network. */
type Subnet = [addr: string, prefix: number, type: 'ipv4' | 'ipv6'];
const PRESETS: Record<string, Subnet[]> = {
  loopback: [
    ['127.0.0.0', 8, 'ipv4'],
    ['::1', 128, 'ipv6'],
  ],
  linklocal: [
    ['169.254.0.0', 16, 'ipv4'],
    ['fe80::', 10, 'ipv6'],
  ],
  uniquelocal: [
    ['10.0.0.0', 8, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['fc00::', 7, 'ipv6'],
  ],
};
PRESETS.private = [...PRESETS.loopback, ...PRESETS.linklocal, ...PRESETS.uniquelocal];

/**
 * Build a `net.BlockList` of trusted-proxy source addresses from the operator's
 * `gateway.trustedProxies` config, or `null` when nothing valid was configured.
 * `null` is the fail-safe-off signal: with no allowlist we never trust forwarding
 * headers. Accepts preset keywords, single IPs, and `addr/prefix` CIDRs (v4/v6);
 * unparseable entries are skipped rather than throwing.
 */
export function buildTrustList(entries?: readonly string[] | null): net.BlockList | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const list = new net.BlockList();
  let added = 0;
  const addSubnet = (s: Subnet) => {
    try {
      list.addSubnet(s[0], s[1], s[2]);
      added++;
    } catch {
      /* skip malformed preset — never throws to the caller */
    }
  };
  for (const raw of entries) {
    const entry = String(raw ?? '').trim().toLowerCase();
    if (!entry) continue;
    const preset = PRESETS[entry];
    if (preset) {
      preset.forEach(addSubnet);
      continue;
    }
    if (entry.includes('/')) {
      const [addr, prefixStr] = entry.split('/', 2);
      const prefix = Number(prefixStr);
      const type = net.isIPv4(addr) ? 'ipv4' : net.isIPv6(addr) ? 'ipv6' : null;
      if (type && Number.isInteger(prefix)) addSubnet([addr, prefix, type]);
      continue;
    }
    const type = net.isIPv4(entry) ? 'ipv4' : net.isIPv6(entry) ? 'ipv6' : null;
    if (type) {
      try {
        list.addAddress(entry, type);
        added++;
      } catch {
        /* skip malformed address */
      }
    }
  }
  return added > 0 ? list : null;
}

/** Normalize a socket peer address for BlockList checks: unwrap IPv4-mapped
 *  IPv6 (`::ffff:1.2.3.4` → `1.2.3.4`) and classify the family. */
function normalizeAddr(addr?: string | null): { ip: string; type: 'ipv4' | 'ipv6' } | null {
  if (!addr) return null;
  let ip = addr.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1] ?? ip;
  if (net.isIPv4(ip)) return { ip, type: 'ipv4' };
  if (net.isIPv6(ip)) return { ip, type: 'ipv6' };
  return null;
}

/**
 * True only when the request's immediate TCP peer is an allowlisted trusted
 * proxy. `null` trust list (no allowlist configured) → always false, so the
 * inbound-Host fallback stays off by default.
 */
export function isTrustedPeer(
  remoteAddr: string | undefined | null,
  trustList: net.BlockList | null,
): boolean {
  if (!trustList) return false;
  const n = normalizeAddr(remoteAddr);
  if (!n) return false;
  try {
    return trustList.check(n.ip, n.type);
  } catch {
    return false;
  }
}

/**
 * Extract a genuinely-external public host from an inbound request's headers.
 * PURE extractor — it assumes the caller has already established that the request
 * came from a trusted proxy (see `learnableHostFromRequest`); it does NOT decide
 * trust on its own.
 *
 * Prefers `X-Forwarded-Host` (set by the proxy) then falls back to `Host`. When
 * the header carries a comma list it takes the LAST (closest-hop) segment — the
 * value vouched for by the immediately-trusted proxy — never a client-supplied
 * leftmost value. Rejects loopback / internal / bare (dotless) hosts: those come
 * from the MCP subprocess (127.0.0.1), Docker health checks, or direct-IP hits
 * and must never clobber the real public host once it has been learned.
 */
export function externalHostFromHeaders(headers: IncomingHttpHeaders): string {
  const fwd = headers['x-forwarded-host'];
  const fwdStr =
    typeof fwd === 'string' ? fwd : Array.isArray(fwd) ? fwd[fwd.length - 1] ?? '' : '';
  const source = fwdStr || (typeof headers.host === 'string' ? headers.host : '');
  const segs = source.split(',');
  const hostPort = (segs[segs.length - 1] ?? '').trim().toLowerCase();
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

/**
 * Trust-gated host learner used by the request middleware: returns a learnable
 * public host ONLY when the immediate peer is an allowlisted trusted proxy,
 * otherwise ''. This is the single choke point that makes header learning
 * fail-safe-off.
 */
export function learnableHostFromRequest(
  remoteAddr: string | undefined | null,
  headers: IncomingHttpHeaders,
  trustList: net.BlockList | null,
): string {
  if (!isTrustedPeer(remoteAddr, trustList)) return '';
  return externalHostFromHeaders(headers);
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
