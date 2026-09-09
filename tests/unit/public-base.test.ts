/**
 * Unit tests for the inbound-Host fallback helper (src/config/public-base.ts):
 * host extraction/validation, atomic idempotent persistence, and read-back.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  externalHostFromHeaders,
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

    it('takes the first entry of a comma list and lowercases', () => {
      expect(
        externalHostFromHeaders({ 'x-forwarded-host': 'Pod-X.Vm.Example.com, other.com' }),
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
