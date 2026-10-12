// Worker tools that replace Claude Code's native `Agent` for agents set up for
// pstack (see src/pstack). Their parameters mirror `Agent`, so a skill passes
// the same arguments it would natively. Shared with the MCP server via dist/.
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const ids = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 };
export const SUBAGENT_TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  { name: 'subagent_spawn', description: 'Use this instead of the Agent tool. Runs a subagent as a gateway task with the same arguments: description, prompt, subagent_type (e.g. pstack:effort-high, pstack:poteto-agent), model (a full model ID from the pstack sheet; omit, inherit-parent or auto for your own model), readonly, run_in_background. With run_in_background=false (default) it waits and returns the result; otherwise it returns a task_id for subagent_wait.',
    inputSchema: schema({ description: { type: 'string' }, prompt: { type: 'string' }, subagent_type: { type: 'string' }, model: { type: 'string' }, readonly: { type: 'boolean' }, run_in_background: { type: 'boolean' }, isolation: { type: 'string' } }, ['description', 'prompt']) },
  { name: 'subagent_wait', description: 'Wait until every listed subagent has finished (or asked a question) and return their results, including failures.', inputSchema: schema({ task_ids: ids }, ['task_ids']) },
  { name: 'subagent_cancel', description: 'Cancel subagents you spawned.', inputSchema: schema({ task_ids: ids }, ['task_ids']) },
];
/** Subagents may nest this deep below the root worker, like Claude Code's default. */
export const SUBAGENT_MAX_DEPTH = 3;
