// This entry is bundled for Node and evaluated only inside the selected app.
// Reuse the host file reader so scope/enablement/resource rules cannot drift.
import { readFileSync } from 'fs';
import { readClaudeExtensions, mergeCodexExtensions, addUnambiguousSkillAliases } from '../dist/session/worker-extensions.js';

const result = readClaudeExtensions(process.argv[1] || '/workspace', { ...process.env, HOME: process.argv[2] || process.env.HOME });
const native = (globalThis as any).__gatewayNativeExtensions;
if (native) mergeCodexExtensions(result, native);
for (const name of Object.keys(result.servers)) if (name.startsWith('codex_')) delete result.servers[name];
let size = 0;
for (const skill of result.skills) {
  skill.content = readFileSync(skill.filePath, 'utf8');
  size += Buffer.byteLength(skill.content);
  if (size > 8 * 1024 * 1024) throw new Error('CONTAINER_EXTENSION_CATALOG_TOO_LARGE');
  skill.fileScope = 'container';
}
addUnambiguousSkillAliases(result.skills);
process.stdout.write(JSON.stringify(result));
