import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { skillCommand } from '../orchestration/skills';
import { extractFrontmatter } from '../skills/parser';
import type { ConversationScope } from '../orchestration/types';
import type { AgentPstackConfig } from './config';
import { pstackPluginInfo } from './plugin-info';

/** Readonly is the spawning skill's choice. Claude children also lose write tools; on Codex, as in pstack's own Codex mapping, it is this instruction.
 * It overrides an agent definition's "You have the full tool set". */
export const SUBAGENT_READONLY = 'Read-only subagent: you have read-only tools, whatever an agent definition says about the full tool set. Inspect and report only. Do not edit, create or delete files, and do not run commands that change state. Any subagents you start are read-only too, so do not hand them changes to make: report the changes you would make in your result.';

/**
 * What a pstack agent's Claude worker is told about running pstack here. The
 * skills say `Agent`; rather than edit them, the worker maps the call.
 */
export function pstackWorkerNote(subagents: boolean): string {
  return [
    '# pstack on this gateway',
    subagents
      ? 'Wherever a pstack skill says to dispatch or spawn a subagent with the Agent tool, call subagent_spawn instead with the same arguments (description, prompt, subagent_type, model, readonly, run_in_background); its model is the model ID from the sheet above. Wait for background subagents with subagent_wait and stop them with subagent_cancel. Each subagent runs as a gateway task, possibly on another provider.'
      : 'Subagent dispatch is unavailable at this depth: do the work a skill would hand to a subagent yourself, inline.',
    'The setup-pstack skill does not apply here: this agent is configured with /pstack-setup.',
  ].join('\n');
}

/**
 * What a pstack agent's decision turn is told: its skill catalog lists the
 * pstack:* skills, but nothing there says what pstack is.
 */
export const PSTACK_DECISION_NOTE = [
  '# pstack on this agent',
  'pstack here means the installed pstack@pstack-claude Claude Code plugin (the pstack:* skills in the catalog), not the Unix process stack tool. Its skills run only in workers: task_spawn with target_profile=skill-worker and skill_name pstack:<name>. pstack:poteto-mode picks the right pstack playbook (bug fix, feature, review...) by itself.',
].join('\n');

/**
 * The reply to an explicit `/pstack:<skill>` on an agent that is not set up.
 * Its workers do not load pstack and its skill catalog does not list it, but a
 * host worker could still find the plugin's files on disk; the command is
 * answered here instead of reaching the agent.
 */
export function pstackNotSetUpReply(text: string, source: ConversationScope['source'], pstack: AgentPstackConfig | undefined): string | undefined {
  const command = skillCommand(text, source);
  if (pstack || !command?.name.startsWith('pstack:')) return undefined;
  const how = source === 'telegram' ? 'with /pstack_setup in a direct message with the bot'
    : source === 'api' ? 'with /pstack-setup on (needs an API key with write access to this agent) or PUT /api/v1/agents/<agent-id>/pstack'
    : 'with /pstack-setup in a direct message with the bot (or PUT /api/v1/agents/<agent-id>/pstack)';
  return `pstack is not set up for this agent, so /${command.name} is not available here. Set it up ${how}, then send the command again.`;
}

/**
 * The reply to an explicit `/pstack:<skill>` on a set-up agent that Claude Code
 * would not run as a command: a skill that is `user-invocable: false` (the
 * principle-* skills, which the worker loads when a task needs them), or a name
 * the plugin has no skill for. Answered here, so it never waits on a decision turn.
 */
export function pstackCommandReply(text: string, source: ConversationScope['source'], pstack: AgentPstackConfig | undefined): string | undefined {
  const command = skillCommand(text, source);
  const skill = command?.name.startsWith('pstack:') ? command.name.slice('pstack:'.length) : undefined;
  if (!pstack || skill === undefined) return undefined;
  const { installPath } = pstackPluginInfo();
  if (!installPath) return undefined;
  const skills = join(installPath, 'skills');
  const read = (name: string) => readFileSync(join(skills, name, 'SKILL.md'), 'utf8');
  let names: string[];
  // Without a readable skill list the gateway cannot tell an unknown name; the agent decides.
  try { names = readdirSync(skills); } catch { return undefined; }
  if (/^[\w-][\w.-]*$/.test(skill)) {
    let content: string | undefined;
    try { content = read(skill); } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    }
    if (content !== undefined) {
      if (extractFrontmatter(content)?.frontmatter['user-invocable'] !== false) return undefined;
      return `/${command!.name} is not a command: pstack loads this skill by itself while a task needs it, as in Claude Code. Describe the task instead, or start one with a pstack command such as /pstack:poteto-mode.`;
    }
  }
  const words = new Set(skill.split(/[^a-z0-9]+/i).filter(word => word.length > 2));
  const invocable = (name: string) => { try { return extractFrontmatter(read(name))?.frontmatter['user-invocable'] !== false; } catch { return false; } };
  // Shared words, or a typo (`reflct`) within about one edit per four letters; nearest first.
  const distance = (name: string) => editDistance(skill.toLowerCase(), name.toLowerCase());
  const close = !skill ? [] : names
    .filter(name => name.includes(skill) || skill.includes(name) || name.split('-').some(word => words.has(word)) || distance(name) <= Math.min(3, Math.max(1, Math.floor(name.length / 4))))
    .sort((a, b) => distance(a) - distance(b)).filter(invocable).slice(0, 3);
  return `/${command!.name} is not a pstack command.${close.length ? ` Did you mean ${close.map(name => `/pstack:${name}`).join(', ')}?` : ''}${names.includes('poteto-help') ? ' Send /pstack:poteto-help with a question to find the right one.' : ''}`;
}

/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent swaps. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 1000; // Far apart; finite so sorting never compares NaN.
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i ? (j ? 0 : i) : j));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
