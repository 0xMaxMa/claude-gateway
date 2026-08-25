import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { parseAppYaml, generateCompose, processAppYaml } from '../../../src/apps/compose-generator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'compose-gen-test-'));
}

function writeAppYaml(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, 'app.yaml'), content, 'utf-8');
}

function readCompose(outputPath: string): Record<string, unknown> {
  const raw = fs.readFileSync(outputPath, 'utf-8');
  // Strip the banner comment line
  const withoutBanner = raw.replace(/^#.*\n/, '');
  return yaml.load(withoutBanner) as Record<string, unknown>;
}

const MINIMAL_IMAGE_YAML = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  web:
    image: nginx:1.25
    ports:
      - name: app
        host: 8080
        container: 8080
        type: api
`.trim();

const MINIMAL_BUILD_YAML = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  web:
    build: .
    ports:
      - name: app
        host: 8080
        container: 8080
`.trim();

// ─── parseAppYaml ─────────────────────────────────────────────────────────────

describe('parseAppYaml()', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });

  it('parses a valid minimal yaml', () => {
    const result = parseAppYaml(MINIMAL_IMAGE_YAML, dir);
    expect(result.name).toBe('my-app');
    expect(result.version).toBe('1.0.0');
  });

  it('throws on invalid YAML syntax', () => {
    expect(() => parseAppYaml('services: [\nno close', dir)).toThrow('Failed to parse');
  });

  it('throws when apiVersion is missing', () => {
    const yaml = MINIMAL_IMAGE_YAML.replace('apiVersion: apps.getpod.ai/v1\n', '');
    expect(() => parseAppYaml(yaml, dir)).toThrow('"apiVersion"');
  });

  it('throws when name is missing', () => {
    const y = MINIMAL_IMAGE_YAML.replace('name: my-app\n', '');
    expect(() => parseAppYaml(y, dir)).toThrow('"name"');
  });

  it('throws when services is missing', () => {
    const y = 'apiVersion: apps.getpod.ai/v1\nname: x\nversion: 1.0.0\ncommit: "abc123def456abc123def456abc123def456abc1"\n';
    expect(() => parseAppYaml(y, dir)).toThrow('"services"');
  });

  describe('service validation', () => {
    it('throws on banned service field', () => {
      const y = MINIMAL_IMAGE_YAML.replace('image: nginx:1.25', 'image: nginx:1.25\n    privileged: true');
      expect(() => parseAppYaml(y, dir)).toThrow('banned field');
    });

    it('throws when service has neither build nor image', () => {
      const y = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  web:
    ports:
      - name: app
        host: 8080
        container: 8080
`.trim();
      expect(() => parseAppYaml(y, dir)).toThrow('"build" or "image"');
    });

    it('throws when service has both build and image', () => {
      const y = MINIMAL_IMAGE_YAML.replace('image: nginx:1.25', 'image: nginx:1.25\n    build: .');
      expect(() => parseAppYaml(y, dir)).toThrow('both');
    });

    it('throws on image with uppercase characters', () => {
      const y = MINIMAL_IMAGE_YAML.replace('nginx:1.25', 'NGINX:1.25');
      expect(() => parseAppYaml(y, dir)).toThrow('invalid characters');
    });

    it('throws on command with newline', () => {
      // In YAML double-quoted strings, \n is a newline escape — this produces a
      // literal newline character in the parsed command value.
      const withNewline = MINIMAL_IMAGE_YAML + '\n    command: "sleep\\necho bad"';
      expect(() => parseAppYaml(withNewline, dir)).toThrow('invalid characters');
    });

    describe('environment', () => {
      it('throws on environment key with lowercase', () => {
        const y = MINIMAL_IMAGE_YAML + '\n    environment:\n      - bad_key';
        expect(() => parseAppYaml(y, dir)).toThrow('bad_key');
      });

      it('accepts uppercase env key', () => {
        const y = MINIMAL_IMAGE_YAML + '\n    environment:\n      - MY_SECRET';
        expect(() => parseAppYaml(y, dir)).not.toThrow();
      });

      it('accepts KEY=VALUE format', () => {
        const y = MINIMAL_IMAGE_YAML + '\n    environment:\n      - MY_VAR=hello';
        expect(() => parseAppYaml(y, dir)).not.toThrow();
      });

      describe('generator marker', () => {
        it('accepts a valid !generate marker', () => {
          const y = MINIMAL_IMAGE_YAML + '\n    environment:\n      - NEXTAUTH_SECRET=!generate:base64:32';
          expect(() => parseAppYaml(y, dir)).not.toThrow();
        });

        it('accepts hex and base64url encodings', () => {
          const yHex = MINIMAL_IMAGE_YAML + '\n    environment:\n      - TOKEN=!generate:hex:16';
          const yUrl = MINIMAL_IMAGE_YAML + '\n    environment:\n      - DB_PASSWORD=!generate:base64url:24';
          expect(() => parseAppYaml(yHex, dir)).not.toThrow();
          expect(() => parseAppYaml(yUrl, dir)).not.toThrow();
        });

        it('throws naming service and key on unknown encoding', () => {
          const y = MINIMAL_IMAGE_YAML + '\n    environment:\n      - SECRET=!generate:rot13:32';
          expect(() => parseAppYaml(y, dir)).toThrow(/web.*SECRET.*rot13/);
        });

        it('throws on non-numeric length', () => {
          const y = MINIMAL_IMAGE_YAML + '\n    environment:\n      - SECRET=!generate:base64:lots';
          expect(() => parseAppYaml(y, dir)).toThrow(/SECRET.*integer/);
        });

        it('throws on out-of-range length', () => {
          const yLow = MINIMAL_IMAGE_YAML + '\n    environment:\n      - SECRET=!generate:base64:2';
          const yHigh = MINIMAL_IMAGE_YAML + '\n    environment:\n      - SECRET=!generate:base64:99999';
          expect(() => parseAppYaml(yLow, dir)).toThrow(/SECRET.*out of range/);
          expect(() => parseAppYaml(yHigh, dir)).toThrow(/SECRET.*out of range/);
        });

        it('throws on malformed marker shape', () => {
          const y = MINIMAL_IMAGE_YAML + '\n    environment:\n      - SECRET=!generate:base64';
          expect(() => parseAppYaml(y, dir)).toThrow(/SECRET.*!generate/);
        });
      });
    });

    describe('ports', () => {
      it('throws on port 22 (banned)', () => {
        const y = MINIMAL_IMAGE_YAML.replace('container: 8080', 'container: 22');
        expect(() => parseAppYaml(y, dir)).toThrow('banned');
      });

      it('throws on port 80 (banned)', () => {
        const y = MINIMAL_IMAGE_YAML.replace('container: 8080', 'container: 80');
        expect(() => parseAppYaml(y, dir)).toThrow('banned');
      });

      it('throws on port 443 (banned)', () => {
        const y = MINIMAL_IMAGE_YAML.replace('container: 8080', 'container: 443');
        expect(() => parseAppYaml(y, dir)).toThrow('banned');
      });

      it('throws on port 10850 (gateway port, banned)', () => {
        const y = MINIMAL_IMAGE_YAML.replace('container: 8080', 'container: 10850');
        expect(() => parseAppYaml(y, dir)).toThrow('banned');
      });

      it('throws on port < 1024', () => {
        const y = MINIMAL_IMAGE_YAML.replace('container: 8080', 'container: 1023');
        expect(() => parseAppYaml(y, dir)).toThrow('banned');
      });

      it('throws on invalid port type', () => {
        const y = MINIMAL_IMAGE_YAML.replace('type: api', 'type: grpc');
        expect(() => parseAppYaml(y, dir)).toThrow('"api" or "web"');
      });
    });

    describe('volumes', () => {
      it('accepts host mount with absolute path', () => {
        const y = MINIMAL_IMAGE_YAML + '\n    volumes:\n      - /proc/stat:/host-proc/stat:ro';
        expect(() => parseAppYaml(y, dir)).not.toThrow();
      });

      it('throws on host mount with path traversal', () => {
        const y = MINIMAL_IMAGE_YAML + '\n    volumes:\n      - /etc/../etc/shadow:/shadow:ro';
        expect(() => parseAppYaml(y, dir)).toThrow('path traversal');
      });

      it('throws on named volume with invalid characters', () => {
        const y = MINIMAL_IMAGE_YAML + '\n    volumes:\n      - Invalid_Volume:/data';
        expect(() => parseAppYaml(y, dir)).toThrow('named volume');
      });

      it('throws on target with path traversal', () => {
        const y = MINIMAL_IMAGE_YAML + '\n    volumes:\n      - /proc/stat:/data/../etc:ro';
        expect(() => parseAppYaml(y, dir)).toThrow('path traversal');
      });

      it('throws on volume mode other than ro/rw', () => {
        const y = MINIMAL_IMAGE_YAML + '\n    volumes:\n      - /proc/stat:/host:shared';
        expect(() => parseAppYaml(y, dir)).toThrow('mode');
      });

      it('accepts named volume without mode', () => {
        const y = MINIMAL_IMAGE_YAML + '\n    volumes:\n      - db-data:/var/lib/data';
        expect(() => parseAppYaml(y, dir)).not.toThrow();
      });
    });

    describe('gateway_api', () => {
      it('throws on script with absolute path', () => {
        const y = MINIMAL_IMAGE_YAML + `
    gateway_api:
      socket: /run/gateway.sock
      scripts:
        bad-script:
          path: /etc/scripts/bad.sh
          timeout: 10s`;
        expect(() => parseAppYaml(y, dir)).toThrow('relative');
      });

      it('throws on script without .sh extension', () => {
        const y = MINIMAL_IMAGE_YAML + `
    gateway_api:
      socket: /run/gateway.sock
      scripts:
        bad-script:
          path: scripts/bad.py
          timeout: 10s`;
        expect(() => parseAppYaml(y, dir)).toThrow('.sh');
      });

      it('throws on script with path traversal', () => {
        const y = MINIMAL_IMAGE_YAML + `
    gateway_api:
      socket: /run/gateway.sock
      scripts:
        escape:
          path: ../../../evil.sh
          timeout: 10s`;
        expect(() => parseAppYaml(y, dir)).toThrow('within the app directory');
      });

      it('accepts valid script declaration', () => {
        const y = MINIMAL_IMAGE_YAML + `
    gateway_api:
      socket: /run/gateway.sock
      scripts:
        resize-disk:
          path: scripts/resize-disk.sh
          timeout: 60s`;
        expect(() => parseAppYaml(y, dir)).not.toThrow();
      });
    });

    describe('agent service', () => {
      it('throws when agent service has extra fields', () => {
        const y = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  web:
    image: nginx:1.25
  agent:
    path: ./agent
    name: my-agent
    image: debian:slim
`.trim();
        expect(() => parseAppYaml(y, dir)).toThrow('invalid field');
      });

      it('throws on invalid agent name', () => {
        const y = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  web:
    image: nginx:1.25
  agent:
    path: ./agent
    name: My-Agent
`.trim();
        expect(() => parseAppYaml(y, dir)).toThrow('"name"');
      });

      it('accepts valid agent declaration', () => {
        const y = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  web:
    image: nginx:1.25
  agent:
    path: ./agent
    name: my-agent-bot
`.trim();
        expect(() => parseAppYaml(y, dir)).not.toThrow();
      });
    });
  });

  describe('resources validation', () => {
    it('throws when cpu exceeds 4.0', () => {
      const y = MINIMAL_IMAGE_YAML + '\nresources:\n  cpu: 5.0';
      expect(() => parseAppYaml(y, dir)).toThrow('cpu');
    });

    it('throws when memory exceeds 2G', () => {
      const y = MINIMAL_IMAGE_YAML + '\nresources:\n  memory: "3G"';
      expect(() => parseAppYaml(y, dir)).toThrow('maximum');
    });

    it('throws on invalid memory format', () => {
      const y = MINIMAL_IMAGE_YAML + '\nresources:\n  memory: "256MB"';
      expect(() => parseAppYaml(y, dir)).toThrow('memory format');
    });

    it('accepts valid resources', () => {
      const y = MINIMAL_IMAGE_YAML + '\nresources:\n  cpu: 2.0\n  memory: "512M"';
      expect(() => parseAppYaml(y, dir)).not.toThrow();
    });
  });
});

// ─── generateCompose ──────────────────────────────────────────────────────────

describe('generateCompose()', () => {
  let appDir: string;
  let outputPath: string;

  beforeEach(() => {
    appDir = makeTmpDir();
    outputPath = path.join(makeTmpDir(), 'docker-compose.yml');
  });

  function generate(yamlContent: string, appName = 'my-app'): ReturnType<typeof generateCompose> {
    const appYaml = parseAppYaml(yamlContent, appDir);
    return generateCompose(appYaml, appName, appDir, outputPath);
  }

  it('rejects a bind mount that escapes the app directory', () => {
    expect(() => generate(`
apiVersion: apps.getpod.ai/v1
name: bound-app
version: 1.0.0
services:
  app:
    image: nginx:1.25
    volumes:
      - ../other-app/data:/data
`)).toThrow(/stay within the app directory/);
  });

  it('writes a valid YAML file', () => {
    generate(MINIMAL_IMAGE_YAML);
    expect(() => readCompose(outputPath)).not.toThrow();
  });

  it('always injects cap_drop: [ALL]', () => {
    generate(MINIMAL_IMAGE_YAML);
    const compose = readCompose(outputPath);
    const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
    expect(svc.cap_drop).toEqual(['ALL']);
  });

  it('always injects restart: unless-stopped', () => {
    generate(MINIMAL_IMAGE_YAML);
    const compose = readCompose(outputPath);
    const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
    expect(svc.restart).toBe('unless-stopped');
  });

  it('always injects env_file: .env', () => {
    generate(MINIMAL_IMAGE_YAML);
    const compose = readCompose(outputPath);
    const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
    expect(svc.env_file).toBe('.env');
  });

  it('always injects deploy.resources.limits', () => {
    generate(MINIMAL_IMAGE_YAML);
    const compose = readCompose(outputPath);
    const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
    const deploy = svc.deploy as Record<string, unknown>;
    const resources = deploy.resources as Record<string, unknown>;
    const limits = resources.limits as Record<string, unknown>;
    expect(limits.cpus).toBeDefined();
    expect(limits.memory).toBeDefined();
  });

  it('uses custom resources when specified', () => {
    const y = MINIMAL_IMAGE_YAML + '\nresources:\n  cpu: 2.0\n  memory: "512M"';
    generate(y);
    const compose = readCompose(outputPath);
    const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
    const limits = ((svc.deploy as Record<string, unknown>).resources as Record<string, unknown>).limits as Record<string, unknown>;
    expect(limits.cpus).toBe('2');
    expect(limits.memory).toBe('512M');
  });

  it('uses default resources when not specified (1.0 cpu, 256M)', () => {
    generate(MINIMAL_IMAGE_YAML);
    const compose = readCompose(outputPath);
    const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
    const limits = ((svc.deploy as Record<string, unknown>).resources as Record<string, unknown>).limits as Record<string, unknown>;
    expect(limits.cpus).toBe('1');
    expect(limits.memory).toBe('256M');
  });

  it('sets container_name as <appName>-<serviceName>', () => {
    generate(MINIMAL_IMAGE_YAML, 'my-app');
    const compose = readCompose(outputPath);
    const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
    expect(svc.container_name).toBe('my-app-web');
  });

  it('never generates network_mode field', () => {
    generate(MINIMAL_IMAGE_YAML);
    const compose = readCompose(outputPath);
    const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
    expect(svc).not.toHaveProperty('network_mode');
  });

  it('never generates privileged field', () => {
    generate(MINIMAL_IMAGE_YAML);
    const compose = readCompose(outputPath);
    const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
    expect(svc).not.toHaveProperty('privileged');
  });

  it('never generates cap_add field', () => {
    generate(MINIMAL_IMAGE_YAML);
    const compose = readCompose(outputPath);
    const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
    expect(svc).not.toHaveProperty('cap_add');
  });

  it('returns port metadata', () => {
    const result = generate(MINIMAL_IMAGE_YAML);
    expect(result.ports).toHaveLength(1);
    expect(result.ports[0]).toMatchObject({
      name: 'app',
      service: 'web',
      containerPort: 8080,
      type: 'api',
    });
  });

  it('maps container port to host in compose ports field', () => {
    generate(MINIMAL_IMAGE_YAML);
    const compose = readCompose(outputPath);
    const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
    expect(svc.ports).toContain('8080:8080');
  });

  it('defaults port type to "api" when not specified', () => {
    const result = generate(MINIMAL_BUILD_YAML);
    expect(result.ports[0].type).toBe('api');
  });

  it('defaults rateLimit to 200 when not specified', () => {
    const result = generate(MINIMAL_IMAGE_YAML);
    expect(result.ports[0].rateLimit).toBe(200);
  });

  describe('environment variables', () => {
    const yamlWithEnv = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  web:
    image: nginx:1.25
    environment:
      - SECRET_KEY
      - DB_PASSWORD
      - DATABASE_URL=postgres://user:pass@db:5432/db
      - APP_ENV=production
`.trim();

    it('excludes secret keys (no =) from compose environment', () => {
      generate(yamlWithEnv);
      const compose = readCompose(outputPath);
      const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
      const env = (svc.environment as string[]) ?? [];
      expect(env.some((e: string) => e === 'SECRET_KEY')).toBe(false);
      expect(env.some((e: string) => e === 'DB_PASSWORD')).toBe(false);
    });

    it('includes static key=value in compose environment', () => {
      generate(yamlWithEnv);
      const compose = readCompose(outputPath);
      const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
      const env = (svc.environment as string[]) ?? [];
      expect(env).toContain('DATABASE_URL=postgres://user:pass@db:5432/db');
      expect(env).toContain('APP_ENV=production');
    });

    it('returns secret keys in result.secretKeys', () => {
      const result = generate(yamlWithEnv);
      expect(result.secretKeys).toContain('SECRET_KEY');
      expect(result.secretKeys).toContain('DB_PASSWORD');
    });

    it('does not include static keys in result.secretKeys', () => {
      const result = generate(yamlWithEnv);
      expect(result.secretKeys).not.toContain('DATABASE_URL');
    });
  });

  describe('generated secrets', () => {
    const yamlWithGen = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  web:
    image: nginx:1.25
    environment:
      - NEXTAUTH_SECRET=!generate:base64:32
      - DB_PASSWORD=!generate:base64url:24
      - NEXTAUTH_URL
      - APP_ENV=production
`.trim();

    it('collects generated keys into result.generatedKeys', () => {
      const result = generate(yamlWithGen);
      const byKey = Object.fromEntries(result.generatedKeys.map((g) => [g.key, g]));
      expect(byKey['NEXTAUTH_SECRET']).toEqual({ key: 'NEXTAUTH_SECRET', encoding: 'base64', bytes: 32 });
      expect(byKey['DB_PASSWORD']).toEqual({ key: 'DB_PASSWORD', encoding: 'base64url', bytes: 24 });
    });

    it('keeps generated keys out of the compose environment block', () => {
      generate(yamlWithGen);
      const compose = readCompose(outputPath);
      const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
      const env = (svc.environment as string[]) ?? [];
      expect(env.some((e) => e.startsWith('NEXTAUTH_SECRET'))).toBe(false);
      expect(env.some((e) => e.startsWith('DB_PASSWORD'))).toBe(false);
      // ...but a real static var still passes through
      expect(env).toContain('APP_ENV=production');
    });

    it('does not report generated keys as secretKeys to prompt for', () => {
      const result = generate(yamlWithGen);
      expect(result.secretKeys).not.toContain('NEXTAUTH_SECRET');
      expect(result.secretKeys).not.toContain('DB_PASSWORD');
      // a genuine bare key is still a prompt
      expect(result.secretKeys).toContain('NEXTAUTH_URL');
    });
  });

  describe('prompt-with-default secrets (!default:)', () => {
    const yamlWithDefault = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  web:
    image: nginx:1.25
    environment:
      - NEXTAUTH_URL=!default:http://localhost:3737
      - PLAIN_SECRET
      - APP_ENV=production
`.trim();

    it('prompts the default key (appears in secretKeys) and records its default', () => {
      const result = generate(yamlWithDefault);
      // Still prompted/visible like a bare key…
      expect(result.secretKeys).toContain('NEXTAUTH_URL');
      // …but carries the declared default. A URL keeps its `:` and `/` intact.
      expect(result.secretDefaults['NEXTAUTH_URL']).toBe('http://localhost:3737');
    });

    it('keeps the default key out of the static compose environment block', () => {
      generate(yamlWithDefault);
      const compose = readCompose(outputPath);
      const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
      const env = (svc.environment as string[]) ?? [];
      expect(env.some((e) => e.startsWith('NEXTAUTH_URL'))).toBe(false);
      // a genuine static var still passes through
      expect(env).toContain('APP_ENV=production');
    });

    it('leaves bare keys with no default out of secretDefaults', () => {
      const result = generate(yamlWithDefault);
      expect(result.secretKeys).toContain('PLAIN_SECRET');
      expect(result.secretDefaults['PLAIN_SECRET']).toBeUndefined();
    });
  });

  describe('volumes', () => {
    it('declares named volumes in top-level volumes section', () => {
      const y = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  db:
    image: postgres:16-alpine
    volumes:
      - db-data:/var/lib/postgresql/data
`.trim();
      generate(y);
      const compose = readCompose(outputPath);
      expect(compose.volumes).toBeDefined();
      expect(Object.keys(compose.volumes as object)).toContain('db-data');
    });

    it('does not create top-level volumes when no named volumes', () => {
      generate(MINIMAL_IMAGE_YAML);
      const compose = readCompose(outputPath);
      expect(compose.volumes).toBeUndefined();
    });
  });

  describe('healthcheck', () => {
    const yamlWithHc = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  web:
    image: nginx:1.25
    healthcheck:
      test: wget -qO- http://localhost:8080/health
      interval: 30s
`.trim();

    it('wraps healthcheck test in CMD-SHELL array', () => {
      generate(yamlWithHc);
      const compose = readCompose(outputPath);
      const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
      const hc = svc.healthcheck as Record<string, unknown>;
      expect(hc.test).toEqual(['CMD-SHELL', 'wget -qO- http://localhost:8080/health']);
    });

    it('adds default timeout and retries', () => {
      generate(yamlWithHc);
      const compose = readCompose(outputPath);
      const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
      const hc = svc.healthcheck as Record<string, unknown>;
      expect(hc.timeout).toBe('10s');
      expect(hc.retries).toBe(3);
    });

    it('prepends BASE_PATH to healthcheck URL for web-type port', () => {
      const yamlWithWebPort = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  app:
    build: ./app
    ports:
      - name: web
        host: 3000
        container: 3000
        type: web
    healthcheck:
      test: wget -qO- http://127.0.0.1:3000/api/health
      interval: 30s
`.trim();
      generate(yamlWithWebPort, 'my-app');
      const compose = readCompose(outputPath);
      const svc = (compose.services as Record<string, unknown>).app as Record<string, unknown>;
      const hc = svc.healthcheck as Record<string, unknown>;
      expect(hc.test).toEqual(['CMD-SHELL', 'wget -qO- http://127.0.0.1:3000/app/my-app/web/api/health']);
    });

    it('does not modify healthcheck URL for non-web port', () => {
      generate(yamlWithHc);
      const compose = readCompose(outputPath);
      const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
      const hc = svc.healthcheck as Record<string, unknown>;
      expect(hc.test).toEqual(['CMD-SHELL', 'wget -qO- http://localhost:8080/health']);
    });
  });

  describe('depends_on', () => {
    const yamlWithDeps = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  app:
    image: node:20-alpine
    depends_on: [db]
  db:
    image: postgres:16-alpine
    healthcheck:
      test: pg_isready -U postgres
      interval: 10s
`.trim();

    it('uses service_healthy when dependency has healthcheck', () => {
      generate(yamlWithDeps);
      const compose = readCompose(outputPath);
      const svc = (compose.services as Record<string, unknown>).app as Record<string, unknown>;
      const deps = svc.depends_on as Record<string, { condition: string }>;
      expect(deps.db.condition).toBe('service_healthy');
    });

    it('uses service_started when dependency has no healthcheck', () => {
      const y = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  app:
    image: node:20-alpine
    depends_on: [cache]
  cache:
    image: redis:7-alpine
`.trim();
      generate(y);
      const compose = readCompose(outputPath);
      const svc = (compose.services as Record<string, unknown>).app as Record<string, unknown>;
      const deps = svc.depends_on as Record<string, { condition: string }>;
      expect(deps.cache.condition).toBe('service_started');
    });
  });

  describe('gateway_api', () => {
    const yamlWithSocket = `
apiVersion: apps.getpod.ai/v1
name: getpod-manager
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  app:
    build: .
    gateway_api:
      socket: /run/gateway.sock
      scripts:
        resize-disk:
          path: scripts/resize-disk.sh
          timeout: 60s
          args:
            - name: disk_device
              type: string
              pattern: "^/dev/(sd|vd)[a-z]$"
`.trim();

    it('injects socket volume into service', () => {
      generate(yamlWithSocket, 'getpod-manager');
      const compose = readCompose(outputPath);
      const svc = (compose.services as Record<string, unknown>).app as Record<string, unknown>;
      const vols = svc.volumes as string[];
      // Now mounts directory (getpod-manager-app/) → /run instead of socket file → /run/gateway.sock
      const socketVol = vols.find((v: string) => v.endsWith(':/run'));
      expect(socketVol).toBeDefined();
      expect(socketVol).toMatch(/getpod-manager-app/);
    });

    it('returns socket metadata in result.sockets', () => {
      const result = generate(yamlWithSocket, 'getpod-manager');
      expect(result.sockets).toHaveLength(1);
      expect(result.sockets[0].service).toBe('app');
      expect(result.sockets[0].hostSocketPath).toMatch(
        /getpod-manager-app\/gateway\.sock/,
      );
      expect(result.sockets[0].scripts['resize-disk']).toMatchObject({
        path: 'scripts/resize-disk.sh',
        timeout: '60s',
      });
    });
  });

  describe('agent service', () => {
    const yamlWithAgent = `
apiVersion: apps.getpod.ai/v1
name: agent-note
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  app:
    image: node:20-alpine
  agent:
    path: ./agent
    name: agent-note-bot
`.trim();

    it('excludes agent service from generated compose services', () => {
      generate(yamlWithAgent, 'agent-note');
      const compose = readCompose(outputPath);
      const services = compose.services as Record<string, unknown>;
      expect(services).not.toHaveProperty('agent');
    });

    it('returns agentDeclaration with path and name', () => {
      const result = generate(yamlWithAgent, 'agent-note');
      expect(result.agentDeclaration).toEqual({
        path: './agent',
        name: 'agent-note-bot',
      });
    });

    it('returns null agentDeclaration when no agent service', () => {
      const result = generate(MINIMAL_IMAGE_YAML);
      expect(result.agentDeclaration).toBeNull();
    });
  });

  describe('warnings', () => {
    it('warns on floating :latest tag', () => {
      const y = MINIMAL_IMAGE_YAML.replace('nginx:1.25', 'nginx:latest');
      const result = generate(y);
      expect(result.warnings.some((w) => w.includes(':latest'))).toBe(true);
    });

    it('no warnings for pinned tag', () => {
      const result = generate(MINIMAL_IMAGE_YAML);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('build path validation', () => {
    it('accepts build: "."', () => {
      const appYaml = parseAppYaml(MINIMAL_BUILD_YAML, appDir);
      expect(() => generateCompose(appYaml, 'my-app', appDir, outputPath)).not.toThrow();
    });

    it('throws when build path escapes app directory', () => {
      // Build path validation happens at parse time (parseAppYaml validates all paths)
      const y = MINIMAL_BUILD_YAML.replace('build: .', 'build: ../escape');
      expect(() => parseAppYaml(y, appDir)).toThrow('within the app directory');
    });
  });

  describe('processAppYaml()', () => {
    it('reads and processes app.yaml from appDir', () => {
      writeAppYaml(appDir, MINIMAL_IMAGE_YAML);
      const result = processAppYaml(appDir, 'my-app', outputPath);
      expect(result.ports).toHaveLength(1);
      expect(fs.existsSync(outputPath)).toBe(true);
    });

    it('throws when app.yaml does not exist', () => {
      expect(() => processAppYaml(appDir, 'my-app', outputPath)).toThrow();
    });
  });

  describe('full agent-note scenario', () => {
    const agentNoteYaml = `
apiVersion: apps.getpod.ai/v1
name: agent-note
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
resources:
  cpu: 0.5
  memory: "256M"
services:
  app:
    build: .
    ports:
      - name: web
        host: 4000
        container: 4000
        type: web
    environment:
      - DATABASE_URL=postgres://notes:\${DB_PASSWORD}@db:5432/notes
      - DB_PASSWORD
    depends_on: [db]
    healthcheck:
      test: wget -qO- http://localhost:4000/api/health
      interval: 30s
  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=notes
      - POSTGRES_USER=notes
      - POSTGRES_PASSWORD=\${DB_PASSWORD}
      - DB_PASSWORD
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: pg_isready -U notes
      interval: 10s
  agent:
    path: ./agent
    name: agent-note-bot
`.trim();

    it('generates correct compose with all features', () => {
      const result = generate(agentNoteYaml, 'agent-note');
      const compose = readCompose(outputPath);
      const services = compose.services as Record<string, unknown>;

      // Services present
      expect(Object.keys(services).sort()).toEqual(['app', 'db']);

      // Agent excluded
      expect(services).not.toHaveProperty('agent');

      // Port metadata
      expect(result.ports).toHaveLength(1);
      expect(result.ports[0]).toMatchObject({ name: 'web', type: 'web', containerPort: 4000 });

      // Secret keys
      expect(result.secretKeys).toContain('DB_PASSWORD');

      // Agent declaration
      expect(result.agentDeclaration).toEqual({ path: './agent', name: 'agent-note-bot' });

      // Named volume declared
      expect(Object.keys((compose.volumes ?? {}) as object)).toContain('db-data');

      // depends_on with service_healthy (db has healthcheck)
      const app = services.app as Record<string, unknown>;
      const deps = app.depends_on as Record<string, { condition: string }>;
      expect(deps.db.condition).toBe('service_healthy');

      // BASE_PATH injected as build arg for web port
      const appBuild = (services.app as Record<string, unknown>).build as Record<string, unknown>;
      expect(appBuild.args).toEqual({ BASE_PATH: '/app/agent-note/web' });

      // Healthcheck URL gets BASE_PATH prepended for web port
      const appHc = app.healthcheck as Record<string, unknown>;
      expect(appHc.test).toEqual(['CMD-SHELL', 'wget -qO- http://localhost:4000/app/agent-note/web/api/health']);

      // Security defaults on both services
      for (const svcName of ['app', 'db']) {
        const svc = services[svcName] as Record<string, unknown>;
        expect(svc.cap_drop).toEqual(['ALL']);
        expect(svc.restart).toBe('unless-stopped');
        expect(svc.env_file).toBe('.env');
      }
    });
  });
});

// ─── generateCompose() — host-port overrides (issue #267) ───────────────────────

describe('generateCompose() — port overrides', () => {
  let appDir: string;
  let outputPath: string;

  beforeEach(() => {
    appDir = makeTmpDir();
    outputPath = path.join(makeTmpDir(), 'docker-compose.yml');
  });

  function generate(
    yamlContent: string,
    overrides?: Record<string, number>,
    appName = 'my-app',
  ): ReturnType<typeof generateCompose> {
    const appYaml = parseAppYaml(yamlContent, appDir);
    return generateCompose(appYaml, appName, appDir, outputPath, overrides);
  }

  const TWO_PORT_YAML = `
apiVersion: apps.getpod.ai/v1
name: my-app
version: 1.0.0
commit: "abc123def456abc123def456abc123def456abc1"
services:
  web:
    image: nginx:1.25
    ports:
      - name: app
        host: 8080
        container: 8080
        type: api
      - name: admin
        host: 9090
        container: 9090
        type: api
`.trim();

  it('uses the app.yaml host port when no override is given', () => {
    const result = generate(MINIMAL_IMAGE_YAML);
    expect(result.ports.find((p) => p.name === 'app')?.hostPort).toBe(8080);
    const compose = readCompose(outputPath);
    const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
    expect(svc.ports).toEqual(['8080:8080']);
  });

  it('overrides the host port for the named port only', () => {
    const result = generate(TWO_PORT_YAML, { app: 8888 });
    expect(result.ports.find((p) => p.name === 'app')?.hostPort).toBe(8888);
    expect(result.ports.find((p) => p.name === 'admin')?.hostPort).toBe(9090);
    const compose = readCompose(outputPath);
    const svc = (compose.services as Record<string, unknown>).web as Record<string, unknown>;
    expect(svc.ports).toEqual(['8888:8080', '9090:9090']);
  });

  it('keeps the container port unchanged when overriding the host port', () => {
    const result = generate(MINIMAL_IMAGE_YAML, { app: 8888 });
    const port = result.ports.find((p) => p.name === 'app');
    expect(port?.hostPort).toBe(8888);
    expect(port?.containerPort).toBe(8080);
  });

  it('rejects a banned override port', () => {
    expect(() => generate(MINIMAL_IMAGE_YAML, { app: 443 })).toThrow('banned');
  });

  it('rejects an override port below 1024', () => {
    expect(() => generate(MINIMAL_IMAGE_YAML, { app: 1000 })).toThrow('below 1024');
  });

  it('rejects the gateway port (10850) as an override', () => {
    expect(() => generate(MINIMAL_IMAGE_YAML, { app: 10850 })).toThrow('banned');
  });

  it('rejects a non-integer override port', () => {
    expect(() => generate(MINIMAL_IMAGE_YAML, { app: 8080.5 })).toThrow('integer');
  });

  it('rejects an override for an unknown port name', () => {
    expect(() => generate(MINIMAL_IMAGE_YAML, { nonexistent: 8888 })).toThrow('unknown port name');
  });

  it('rejects two ports overridden onto the same host port', () => {
    expect(() => generate(TWO_PORT_YAML, { app: 7000, admin: 7000 })).toThrow('more than one port');
  });
});
