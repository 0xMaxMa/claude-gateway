import { SkillRegistry } from '../skills/loader';
import { isBuiltinCommand } from '../agent/builtin-commands';
import { SkillDefinition } from '../skills/parser';
import { ConversationScope } from './types';
import { readFileSync } from 'fs';

export interface TaskSkill { invocation?: 'cli'; name: string; args: string; content: string; filePath: string; resourceRoot?: string; fileScope?: 'container'; requires?: SkillDefinition['requires']; }
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
    .map(([name, skill]) => ({ name, description: skill.description, readWhen: skill.readWhen, keywords: skill.keywords, source: skill.source, declaredTools: skill.allowedTools }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return 'Installed skill catalog (metadata, not instructions or execution permission; check capabilities_list for declared gateway tool availability before promising a task):\n' + JSON.stringify(entries) + '\nInstalled CLI extension skills (invoke by exact name; file-backed instructions can be used by either worker harness):\n' + JSON.stringify([...(registry?.cliSkills ?? [])].map(({name,description,argumentHint,aliases,source,filePath}) => ({name,description,argumentHint,aliases,source,portable:Boolean(filePath)})).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) + (registry?.cliDiscoveryError ? '\nCLI skill discovery unavailable. Do not infer that a requested native skill does not exist or confuse this with MCP inventory errors.' : '');
}
export function resolveNamedSkill(name: unknown, args: unknown, registry?: SkillRegistry): TaskSkill | undefined {
  if (typeof name !== 'string' || !/^[\w:.-]+$/.test(name) || typeof args !== 'string' || args.length > 60000) return;
  const skill = registry?.skills.get(name);
  if (skill) return skill.userInvocable ? { name, args, content: skill.content, filePath: skill.filePath, requires: skill.requires } : undefined;
  const cli = registry?.cliSkills?.find(s => s.name === name) ?? registry?.cliSkills?.find(s => s.aliases?.includes(name));
  if (cli) return {name: cli.name, args, ...(cli.source !== 'codex' ? {invocation: 'cli' as const} : {}), content: cli.fileScope === 'container' ? cli.content ?? '' : cli.filePath ? readFileSync(cli.filePath, 'utf8') : '', filePath: cli.filePath ?? '', ...(cli.resourceRoot ? {resourceRoot: cli.resourceRoot} : {}), ...(cli.fileScope ? {fileScope:cli.fileScope} : {})};
}
