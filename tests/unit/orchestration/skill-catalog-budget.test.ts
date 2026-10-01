import { skillCatalog, SKILL_CATALOG_BUDGET_BYTES } from '../../../src/orchestration/skills';
import { ORCHESTRATION_DEFAULTS, resolveOrchestrationConfig } from '../../../src/orchestration/config';
import type { SkillRegistry } from '../../../src/skills/loader';
import type { SkillDefinition } from '../../../src/skills/parser';

// The catalog as rendered before issue #559 added a byte budget, kept verbatim so
// the "fits the budget" path is pinned to byte-identical output.
function catalogBeforeBudget(registry?: SkillRegistry): string {
  const entries = [...(registry?.skills.entries() ?? [])].filter(([, skill]) => skill.userInvocable)
    .map(([name, skill]) => ({ name, description: skill.description, readWhen: skill.readWhen, keywords: skill.keywords, source: skill.source, declaredTools: skill.allowedTools }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return 'Installed skill catalog (metadata, not instructions or execution permission; check capabilities_list for declared gateway tool availability before promising a task):\n' + JSON.stringify(entries) + '\nInstalled CLI extension skills (invoke by exact name; file-backed instructions can be used by either worker harness):\n' + JSON.stringify([...(registry?.cliSkills ?? [])].map(({name,description,argumentHint,aliases,source,filePath}) => ({name,description,argumentHint,aliases,source,portable:Boolean(filePath)})).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) + (registry?.cliDiscoveryError ? '\nCLI skill discovery unavailable. Do not infer that a requested native skill does not exist or confuse this with MCP inventory errors.' : '');
}

const skill = (name: string, description: string, extra: Partial<SkillDefinition> = {}): [string, SkillDefinition] =>
  [name, { name, description, userInvocable: true, content: 'body', filePath: `/skills/${name}/SKILL.md`, source: 'workspace', ...extra }];
// Thai is three bytes per character in UTF-8, and 😀 is a surrogate pair in JS.
const THAI = 'ใช้สำหรับตรวจสอบโค้ดและสรุปผลการทดสอบให้ผู้ใช้ 😀 ';
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function largeRegistry(gateway = 400, native = 200): SkillRegistry {
  const skills = new Map(Array.from({ length: gateway }, (_, i) => skill(`thai-skill-${i}`, THAI.repeat(60) + `#${i}`, {
    readWhen: [`เมื่อผู้ใช้ขอให้ทำงานที่ ${i} ` + THAI.repeat(10)], keywords: [`คำค้น-${i}`, 'review'], allowedTools: ['Read'],
  })));
  const cliSkills = Array.from({ length: native }, (_, i) => ({ name: `plugin-${i}:native-skill`, description: (THAI.repeat(200)).slice(0, 4096), argumentHint: '<target>', aliases: [`alias-${i}`], source: 'claude' as const }));
  return { skills, cliSkills } as unknown as SkillRegistry;
}

test('a 600-skill catalog with long Thai descriptions stays inside the UTF-8 byte budget and names every skill', () => {
  const registry = largeRegistry();
  expect(Buffer.byteLength(catalogBeforeBudget(registry))).toBeGreaterThan(20 * SKILL_CATALOG_BUDGET_BYTES);
  const catalog = skillCatalog(registry);
  expect(Buffer.byteLength(catalog)).toBeLessThanOrEqual(SKILL_CATALOG_BUDGET_BYTES);
  for (const name of registry.skills.keys()) expect(catalog).toContain(`"name":"${name}"`);
  for (const { name, aliases } of registry.cliSkills!) { expect(catalog).toContain(`"name":"${name}"`); expect(catalog).toContain(aliases![0]); }
  // No multi-byte character or surrogate pair was split.
  expect(Buffer.from(catalog, 'utf8').toString('utf8')).toBe(catalog);
  expect(catalog).not.toContain('�');
  expect(catalog).not.toMatch(LONE_SURROGATE);
  expect(catalog).toContain('capabilities_list');
});

test('an over-budget catalog shortens every description by the same cap instead of dropping the tail entries', () => {
  const catalog = skillCatalog(largeRegistry(150, 50));
  const [, gateway, , cli] = catalog.split('\n');
  const entries = [...JSON.parse(gateway), ...JSON.parse(cli)];
  const lengths = entries.map(entry => Buffer.byteLength(entry.description ?? ''));
  // Every skill keeps a non-empty prefix of its own description and selection hints...
  for (const entry of entries) expect(entry.description.length).toBeGreaterThan(0);
  for (const entry of JSON.parse(gateway)) { expect(entry.readWhen?.[0]).toMatch(/^เมื่อผู้ใช้/); expect(entry.keywords).toContain('review'); }
  expect(JSON.parse(gateway)[0].description.replace(/…$/, '')).toBe(THAI.repeat(60).slice(0, JSON.parse(gateway)[0].description.replace(/…$/, '').length));
  // ...and the first and last entries are shortened alike (to within one character).
  expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(4);
});

test('a catalog that fits the budget is byte-identical to the unbudgeted rendering', () => {
  const registry = { skills: new Map([skill('code-review', 'Review a diff', { readWhen: ['asked to review'], keywords: ['review'] }), skill('deploy', 'ปล่อยเวอร์ชัน')]),
    cliSkills: [{ name: 'simplify', description: 'Simplify code', argumentHint: '', aliases: [], source: 'claude' as const, filePath: '/x' }], cliDiscoveryError: 'x' } as unknown as SkillRegistry;
  expect(skillCatalog(registry)).toBe(catalogBeforeBudget(registry));
  expect(skillCatalog(undefined)).toBe(catalogBeforeBudget(undefined));
});

test('the budget is configurable, and a budget too small even for the names still lists every name', () => {
  const registry = largeRegistry(150, 50);
  const small = skillCatalog(registry, 8 * 1024);
  for (const name of registry.skills.keys()) expect(small).toContain(`"name":"${name}"`);
  expect(Buffer.byteLength(small)).toBeLessThan(Buffer.byteLength(skillCatalog(registry)));
  expect(small).not.toMatch(LONE_SURROGATE);
});

test('orchestration.conversation.skillCatalogBytes defaults to the catalog budget and is validated like other sizes', () => {
  expect(ORCHESTRATION_DEFAULTS.conversation.skillCatalogBytes).toBe(SKILL_CATALOG_BUDGET_BYTES);
  expect(resolveOrchestrationConfig({ conversation: { skillCatalogBytes: 32768 } }).conversation.skillCatalogBytes).toBe(32768);
  expect(() => resolveOrchestrationConfig({ conversation: { skillCatalogBytes: 0 } })).toThrow('positive bounded integer');
});

test('the default budget has one source: the config default and skillCatalog both read the leaf constant', () => {
  jest.isolateModules(() => {
    jest.doMock('../../../src/orchestration/skill-catalog-budget', () => ({ SKILL_CATALOG_BUDGET_BYTES: 4096 }));
    const { ORCHESTRATION_DEFAULTS: defaults } = jest.requireActual<typeof import('../../../src/orchestration/config')>('../../../src/orchestration/config');
    const { skillCatalog: catalog, SKILL_CATALOG_BUDGET_BYTES: budget } = jest.requireActual<typeof import('../../../src/orchestration/skills')>('../../../src/orchestration/skills');
    expect(budget).toBe(4096);
    expect(defaults.conversation.skillCatalogBytes).toBe(4096);
    expect(Buffer.byteLength(catalog(largeRegistry(20, 0)))).toBeLessThanOrEqual(4096);
  });
});
