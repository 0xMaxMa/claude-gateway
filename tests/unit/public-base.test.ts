/**
 * Unit tests for the inbound-Host fallback helper (src/config/public-base.ts):
 * host extraction/validation, the trusted-proxy gate (fail-safe-off), atomic
 * idempotent persistence, and read-back.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  externalHostFromHeaders,
  buildTrustList,
  isTrustedPeer,
  learnableHostFromRequest,
  persistPublicBase,
  readPublicBase,
} from '../../src/config/public-base';

describe('public-base inbound-Host fallback', () => {
  describe('externalHostFromHeaders', () => {
    it('accepts a real external FQDN from Host', () => {
      expect(externalHostFromHeaders({ host: 'pod-abc.develop-vm.getpod.ai' })).toBe(
        'pod-abc.develop-vm.getpod.ai',
      );
    });

    it('prefers X-Forwarded-Host over Host', () => {
      expect(
        externalHostFromHeaders({
          'x-forwarded-host': 'pod-fwd.develop-vm.getpod.ai',
          host: 'internal:10850',
        }),
      ).toBe('pod-fwd.develop-vm.getpod.ai');
    });

    it('takes the last (closest-hop) entry of a comma list and lowercases', () => {
      // A prepended client-supplied value must never win over the proxy's own.
      expect(
        externalHostFromHeaders({ 'x-forwarded-host': 'Evil.com, Pod-X.Vm.Example.com' }),
      ).toBe('pod-x.vm.example.com');
    });

    it('keeps a port when present', () => {
      expect(externalHostFromHeaders({ host: 'pod-x.vm.example.com:8443' })).toBe(
        'pod-x.vm.example.com:8443',
      );
    });

    it.each([
      ['localhost'],
      ['localhost:10850'],
      ['127.0.0.1'],
      ['127.0.0.1:10850'],
      ['0.0.0.0'],
      ['::1'],
      ['gateway'], // bare docker service name (no dot)
      ['pod-x.internal'],
      ['pod-x.local'],
      [''],
      ['bad host!'], // fails HOST_RE
    ])('rejects non-public host %p', (h) => {
      expect(externalHostFromHeaders({ host: h })).toBe('');
    });

    it('returns empty when no host header is present', () => {
      expect(externalHostFromHeaders({})).toBe('');
    });
  });

  describe('buildTrustList', () => {
    it('returns null when no allowlist is configured (fail-safe-off)', () => {
      expect(buildTrustList(undefined)).toBeNull();
      expect(buildTrustList(null)).toBeNull();
      expect(buildTrustList([])).toBeNull();
      expect(buildTrustList(['  ', 'not-an-ip', 'garbage/xx'])).toBeNull();
    });

    it('matches a CIDR entry', () => {
      const list = buildTrustList(['10.0.0.0/8']);
      expect(isTrustedPeer('10.1.2.3', list)).toBe(true);
      expect(isTrustedPeer('11.0.0.1', list)).toBe(false);
    });

    it('matches a single IP entry', () => {
      const list = buildTrustList(['203.0.113.7']);
      expect(isTrustedPeer('203.0.113.7', list)).toBe(true);
      expect(isTrustedPeer('203.0.113.8', list)).toBe(false);
    });

    it('supports the `private` preset (RFC1918 + loopback + link-local)', () => {
      const list = buildTrustList(['private']);
      expect(isTrustedPeer('172.20.0.5', list)).toBe(true); // docker bridge
      expect(isTrustedPeer('192.168.1.10', list)).toBe(true);
      expect(isTrustedPeer('127.0.0.1', list)).toBe(true);
      expect(isTrustedPeer('8.8.8.8', list)).toBe(false); // public
    });

    it('unwraps IPv4-mapped IPv6 peers', () => {
      const list = buildTrustList(['10.0.0.0/8']);
      expect(isTrustedPeer('::ffff:10.1.2.3', list)).toBe(true);
    });

    it('matches IPv6 loopback via preset', () => {
      const list = buildTrustList(['loopback']);
      expect(isTrustedPeer('::1', list)).toBe(true);
      expect(isTrustedPeer('2001:db8::1', list)).toBe(false);
    });
  });

  describe('isTrustedPeer', () => {
    it('is always false without a trust list', () => {
      expect(isTrustedPeer('10.1.2.3', null)).toBe(false);
    });
    it('is false for a missing / unparseable peer address', () => {
      const list = buildTrustList(['private']);
      expect(isTrustedPeer(undefined, list)).toBe(false);
      expect(isTrustedPeer('', list)).toBe(false);
      expect(isTrustedPeer('not-an-ip', list)).toBe(false);
    });
  });

  describe('learnableHostFromRequest (the security gate)', () => {
    const headers = { 'x-forwarded-host': 'pod-x.vm.example.com' };

    it('learns the host when the peer is a trusted proxy', () => {
      const list = buildTrustList(['private']);
      expect(learnableHostFromRequest('172.20.0.5', headers, list)).toBe('pod-x.vm.example.com');
    });

    it('refuses a spoofed X-Forwarded-Host from an untrusted peer', () => {
      const list = buildTrustList(['private']);
      // Public attacker hitting a directly-exposed gateway with a forged header.
      expect(learnableHostFromRequest('203.0.113.9', { 'x-forwarded-host': 'evil.com' }, list)).toBe(
        '',
      );
    });

    it('never learns when no allowlist is configured (default)', () => {
      expect(learnableHostFromRequest('172.20.0.5', headers, null)).toBe('');
    });
  });

  describe('persist + read', () => {
    let root: string;
    let agentsRoot: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'pubbase-'));
      agentsRoot = path.join(root, 'agents');
      fs.mkdirSync(agentsRoot, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('round-trips the https /gateway base one level above the agents root', () => {
      persistPublicBase(agentsRoot, 'pod-abc.develop-vm.getpod.ai');
      expect(readPublicBase(agentsRoot)).toBe('https://pod-abc.develop-vm.getpod.ai/gateway');
      // File lives at <agentsRoot>/../.public-base (gateway-level, shared by agents).
      expect(fs.readFileSync(path.join(root, '.public-base'), 'utf8')).toBe(
        'https://pod-abc.develop-vm.getpod.ai/gateway',
      );
    });

    it('is idempotent: an unchanged value leaves no temp file behind', () => {
      persistPublicBase(agentsRoot, 'pod-abc.develop-vm.getpod.ai');
      persistPublicBase(agentsRoot, 'pod-abc.develop-vm.getpod.ai');
      const leftovers = fs.readdirSync(root).filter((f) => f.includes('.tmp'));
      expect(leftovers).toEqual([]);
      expect(readPublicBase(agentsRoot)).toBe('https://pod-abc.develop-vm.getpod.ai/gateway');
    });

    it('overwrites when the host changes', () => {
      persistPublicBase(agentsRoot, 'old.vm.example.com');
      persistPublicBase(agentsRoot, 'new.vm.example.com');
      expect(readPublicBase(agentsRoot)).toBe('https://new.vm.example.com/gateway');
    });

    it('ignores empty / invalid hosts', () => {
      persistPublicBase(agentsRoot, '');
      persistPublicBase(agentsRoot, 'bad host!');
      expect(readPublicBase(agentsRoot)).toBeNull();
    });

    it('returns null when nothing was persisted', () => {
      expect(readPublicBase(agentsRoot)).toBeNull();
    });
  });
});
