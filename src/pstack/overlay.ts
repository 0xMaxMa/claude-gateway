import { readFileSync } from 'fs';
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
 * The reply to an explicit `/pstack:<skill>` on an agent that is not set up.
 * Its workers do not load pstack and its skill catalog does not list it, but a
 * host worker could still find the plugin's files on disk; the command is
 * answered here instead of reaching the agent.
 */
export function pstackNotSetUpReply(text: string, source: ConversationScope['source'], pstack: AgentPstackConfig | undefined): string | undefined {
  const command = skillCommand(text, source);
  if (pstack || !command?.name.startsWith('pstack:')) return undefined;
  return `pstack is not set up for this agent, so /${command.name} is not available here. Set it up with /pstack-setup in a direct message with the bot (or PUT /v1/agents/<agent-id>/pstack), then send the command again.`;
}

/**
 * The reply to an explicit `/pstack:<skill>` on a set-up agent when that skill
 * is `user-invocable: false` (the principle-* skills). As in Claude Code it is
 * not a command: the worker loads it when a task needs it. Answered here, so it
 * never waits on a decision turn.
 */
export function pstackAutomaticSkillReply(text: string, source: ConversationScope['source'], pstack: AgentPstackConfig | undefined): string | undefined {
  const command = skillCommand(text, source);
  const skill = command?.name.startsWith('pstack:') ? command.name.slice('pstack:'.length) : undefined;
  if (!pstack || !skill || !/^[\w-][\w.-]*$/.test(skill)) return undefined;
  const { installPath } = pstackPluginInfo();
  if (!installPath) return undefined;
  let content: string;
  try { content = readFileSync(join(installPath, 'skills', skill, 'SKILL.md'), 'utf8'); } catch { return undefined; }
  if (extractFrontmatter(content)?.frontmatter['user-invocable'] !== false) return undefined;
  return `/${command!.name} is not a command: pstack loads this skill by itself while a task needs it, as in Claude Code. Describe the task instead, or start one with a pstack command such as /pstack:poteto-mode.`;
}
