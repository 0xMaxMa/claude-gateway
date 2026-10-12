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
