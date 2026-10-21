import { BUILTIN_COMMANDS, type CommandChannel } from './builtin-commands';

const descriptions: Record<string, string> = {
  session: 'Show the current session, model and measured context usage',
  sessions: 'List sessions', new: 'Create a session: /new [name]',
  rename: 'Rename the session: /rename <name>',
  clear: 'Reset model context; keep chat history and load the latest 50 messages next time',
  compact: 'Compact Claude Code context; keep chat history',
  stop: 'Stop the current reply', model: 'Show the model', models: 'List and select a model',
  'pstack-setup': 'Set up pstack for this agent: /pstack-setup [on|off|<role>: <model-id>]',
  restart: 'Restart the session process; keep history (does not restart the gateway or app)',
  start: 'Show pairing instructions', status: 'Show pairing status', help: 'Show available commands',
  tasks: 'View tasks, progress and cancellation controls',
};

/**
 * Shared discoverable built-ins for help, session shortcuts and the API picker.
 * `orchestration` is the agent's mode where one is known; the agent-free API
 * picker leaves it out and says /tasks needs it.
 */
export function commandCatalog(channel: CommandChannel, orchestration?: boolean): Array<{name: string; description: string}> {
  return Object.entries(BUILTIN_COMMANDS)
    .filter(([name, definition]) => definition.channels.includes(channel) && !definition.hidden && !(name === 'tasks' && orchestration === false))
    // The web /models only lists; its model picker or the REST call switches.
    .map(([name]) => ({name: `/${name}`, description: name === 'models' && channel === 'api' ? 'List the models; switch with the model picker or PUT /api/v1/agents/:agentId/model'
      : name === 'tasks' && orchestration === undefined ? `${descriptions[name]} (agents in orchestration mode)` : descriptions[name]}));
}

/** Channel-specific help shares the runner command registry instead of a second partial list. */
export function commandHelp(channel: CommandChannel, orchestration = false, interactive = false): string {
  const lines = commandCatalog(channel, orchestration).map(command => {
    const name = command.name.slice(1);
    let description = command.description;
    // Telegram's receiver handles /model locally; a group change updates the whole agent.
    if (name === 'model' && channel === 'telegram') description = 'Show the model; in groups, authorized users can set /model <model-id> for every chat of this agent';
    if (name === 'model' && ['discord', 'line'].includes(channel)) description = 'Show the model; change it in a private chat: /model [model ID] (applies to every chat of this agent)';
    if (name === 'new' && channel === 'api') description = 'Create a session: /new [name] (the reply carries its session ID)';
    if (name === 'stop' && orchestration) description = 'Stop the reply and choose a task to cancel';
    // Every channel asks before /compact and /restart; only Telegram and the web ask before /clear.
    if (['compact', 'restart'].includes(name) || (name === 'clear' && ['telegram', 'api'].includes(channel))) description += '; confirmation required';
    if (name === 'pstack-setup' && channel === 'telegram') description = 'Set up pstack for this agent with buttons (direct message)';
    if (name === 'pstack-setup' && channel === 'api') description = 'Show the pstack setup; change it with /pstack-setup <role>: <model-id> (needs write access to this agent)';
    // A tapped Telegram command stops at the first character outside [a-z0-9_].
    return `/${channel === 'telegram' ? BUILTIN_COMMANDS[name].alias ?? name : name} — ${description}`;
  });
  if (orchestration && channel !== 'api') {
    lines.push('/tasks — View tasks, progress and cancellation controls', '/task_question — Open a pending task question (use the command supplied with the question)');
    if (['telegram', 'discord', 'line', 'slack'].includes(channel)) lines.push('/voice [on|auto|off] — Set voice replies', '/voices — Choose the agent voice');
    if (channel === 'telegram') lines.push('/call — Start a live voice call (direct message)');
    if (channel !== 'telegram') lines.push('/orch <token> — Use a supplied menu action; tokens expire');
  }
  if (channel === 'discord') lines.push('/ask <question> — Send a message to the agent');
  if (interactive && (channel === 'telegram' || (channel === 'discord' && !orchestration))) lines.push('/cli — Open the live terminal viewer');
  if (channel === 'api') lines.push('', 'REST controls (not slash commands):', 'PUT /api/v1/agents/:agentId/model — Change the model', 'GET/PATCH /api/v1/agents/:agentId/voice-settings — Read or update voice settings', 'GET /api/v1/agents/:agentId/sessions/:sessionId/tasks — List session tasks', 'POST /api/v1/agents/:agentId/sessions/:sessionId/tasks/:taskId/answer or /cancel — Answer or cancel a task');
  return 'Available commands\n\n' + lines.join('\n');
}

/** A button on an API command reply: send `command` back as the message, to the same session with the same key. */
export interface CommandAction { label: string; command: string }
