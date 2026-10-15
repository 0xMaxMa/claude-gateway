// Worker tools that replace Claude Code's native `Agent` for agents set up for
// pstack (see src/pstack). Their parameters mirror `Agent`, so a skill passes
// the same arguments it would natively. Shared with the MCP server via dist/.
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const ids = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 };
export const SUBAGENT_TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  { name: 'subagent_spawn', description: 'Use this instead of the Agent tool. Runs a subagent as a gateway task with the same arguments: description, prompt, subagent_type (e.g. pstack:effort-high, pstack:poteto-agent), model (a model ID or alias, e.g. from the pstack sheet; omit, inherit-parent or auto for your own model), readonly, run_in_background. With run_in_background=false (default) it waits and returns the result; otherwise it returns a task_id for subagent_wait.',
    inputSchema: schema({ description: { type: 'string' }, prompt: { type: 'string' }, subagent_type: { type: 'string' }, model: { type: 'string' }, readonly: { type: 'boolean' }, run_in_background: { type: 'boolean' }, isolation: { type: 'string' } }, ['description', 'prompt']) },
  { name: 'subagent_wait', description: 'Wait until every listed subagent has finished and return their results, including failures. A subagent cannot ask questions; an open question is part of its result.', inputSchema: schema({ task_ids: ids }, ['task_ids']) },
  { name: 'subagent_cancel', description: 'Cancel subagents you spawned.', inputSchema: schema({ task_ids: ids }, ['task_ids']) },
];
/** Subagents may nest this deep below the root worker. */
export const SUBAGENT_MAX_DEPTH = 3;
/** Gateway tools that change something outside the task; a read-only subagent gets none of them. */
export const READONLY_DENIED_TOOLS: readonly string[] = ['cron_create', 'cron_update', 'cron_delete', 'cron_run', 'task_memory_append',
  'memory_shared_create', 'memory_shared_update', 'memory_shared_delete', 'share_file', 'task_share_call', 'narrate', 'generate_image', 'generate_video'];
/** Browser tools act on live pages, so a read-only subagent gets none of them either. */
export const readonlyDenied = (tool: string): boolean => READONLY_DENIED_TOOLS.includes(tool) || tool.startsWith('browser_');
