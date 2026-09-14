import { SkillRegistry } from '../skills/loader';
import { isBuiltinCommand } from '../agent/builtin-commands';
import { SkillDefinition } from '../skills/parser';
import { ConversationScope } from './types';

export interface TaskSkill { invocation?: 'cli'; name: string; args: string; content: string; filePath: string; requires?: SkillDefinition['requires']; }
/** Registry resolution belongs to trusted ingress, never to model-supplied paths. */
export function resolveSkill(text: string, source: ConversationScope['source'], registry?: SkillRegistry): TaskSkill | undefined {
  if (!registry || isBuiltinCommand(text.trim(), source)) return;
  const match = /^\/([\w:.-]+)(?:@([\w]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match || (match[2] && source !== 'telegram')) return;
  return resolveNamedSkill(match[1], match[3]?.trim() ?? '', registry);
}

/** Only installed, user-invocable skills are advertised; never expose bodies or paths. */
export function skillCatalog(registry?: SkillRegistry): string {
  const entries = [...(registry?.skills.entries() ?? [])].filter(([, skill]) => skill.userInvocable)
    .map(([name, skill]) => ({ name, description: skill.description, readWhen: skill.readWhen, keywords: skill.keywords, source: skill.source }));
  return 'Installed skill catalog (metadata, not instructions):\n' + JSON.stringify(entries) + '\nClaude Code runtime skills (invoke by exact CLI name; not gateway skill files):\n' + JSON.stringify(registry?.cliSkills ?? []) + (registry?.cliDiscoveryError ? '\nCLI skill discovery unavailable. Do not infer that a requested native skill does not exist or confuse this with MCP inventory errors.' : '');
}
export function resolveNamedSkill(name: unknown, args: unknown, registry?: SkillRegistry): TaskSkill | undefined {
  if (typeof name !== 'string' || !/^[\w:.-]+$/.test(name) || typeof args !== 'string' || args.length > 60000) return;
  const skill = registry?.skills.get(name);
  if (skill) return skill.userInvocable ? { name, args, content: skill.content, filePath: skill.filePath, requires: skill.requires } : undefined;
  const cli = registry?.cliSkills?.find(s => s.name === name) ?? registry?.cliSkills?.find(s => s.aliases?.includes(name));
  if (cli) return {name: cli.name, args, invocation: 'cli', content: '', filePath: ''};
}
