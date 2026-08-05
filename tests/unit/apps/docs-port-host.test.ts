import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { processAppYaml } from '../../../src/apps/compose-generator';

// Drift guard: the app-authoring docs must teach a `ports:` block that the
// gateway's own validator (validatePorts, reachable via processAppYaml and the
// POST /api/v1/apps/inspect path) actually accepts. Historically both docs
// omitted the required `host` field, so any app.yaml authored by following the
// docs failed at inspect/install with:
//   Service "app".ports["web"].host is required and must be an integer
// These tests fail on the pre-fix docs and pass once `host` is documented.

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const API_MD = path.join(REPO_ROOT, 'API.md');
const SKILL_MD = path.join(
  REPO_ROOT,
  'mcp',
  'tools',
  'apps',
  'skills',
  'create-app-yaml',
  'SKILL.md',
);

/** Extract every ```yaml … ``` fenced block from a Markdown file. */
function extractYamlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /```ya?ml\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

describe('app.yaml authoring docs — required port host field', () => {
  it('every app.yaml example in API.md is accepted by the real validator', () => {
    const md = fs.readFileSync(API_MD, 'utf-8');
    // Validate EVERY manifest-style block (declares both a top-level
    // `apiVersion:` and a concrete `container:` port), not just the first — so
    // a second host-less example added to API.md later is also caught.
    const examples = extractYamlBlocks(md).filter(
      (b) => b.includes('apiVersion:') && b.includes('container:'),
    );
    expect(examples.length).toBeGreaterThan(0);

    for (const example of examples) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-port-host-'));
      try {
        fs.writeFileSync(path.join(dir, 'app.yaml'), example, 'utf-8');
        // Throws "ports[...].host is required" if the example omits host.
        expect(() =>
          processAppYaml(dir, 'my-app', path.join(dir, 'out.yml')),
        ).not.toThrow();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('create-app-yaml SKILL.md port template declares a host field', () => {
    const md = fs.readFileSync(SKILL_MD, 'utf-8');
    // The template uses placeholders (e.g. `container: <port>`) so it cannot be
    // fed to the validator directly — assert structurally that the ports block
    // teaches a `host` key.
    const template = extractYamlBlocks(md).find((b) => b.includes('ports:'));
    expect(template).toBeDefined();

    const portsIdx = (template as string).indexOf('ports:');
    const portsSection = (template as string).slice(portsIdx);
    expect(portsSection).toMatch(/^\s*host:/m);
  });
});
