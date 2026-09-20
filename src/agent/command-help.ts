import { BUILTIN_COMMANDS, type CommandChannel } from './builtin-commands';

const descriptions: Record<string, string> = {
  session: 'Show the current session, model and measured context usage',
  sessions: 'List sessions', new: 'Create a session: /new [name]',
  rename: 'Rename the session: /rename <name>',
  clear: 'Reset model context; keep chat history and load the latest 50 messages next time',
  compact: 'Compact Claude Code context; keep chat history',
  stop: 'Stop the current reply', model: 'Show the model', models: 'List and select a model',
  restart: 'Restart the session process; keep history (does not restart the gateway or app)',
  start: 'Show pairing instructions', status: 'Show pairing status', help: 'Show available commands',
};

/** Channel-specific help shares the runner command registry instead of a second partial list. */
export function commandHelp(channel: CommandChannel, orchestration = false, interactive = false): string {
  const lines = Object.entries(BUILTIN_COMMANDS).filter(([, def]) => def.channels.includes(channel)).map(([name]) => {
    let description = descriptions[name];
    if (name === 'model' && ['telegram', 'discord', 'line'].includes(channel)) description = 'Show the model; change it in a private chat: /model [model ID]';
    if (name === 'stop' && orchestration) description = 'Stop the reply and choose a task to cancel';
    if (name === 'compact' && channel !== 'api') description += '; confirmation required';
    return `/${name} — ${description}`;
  });
  if (orchestration && channel !== 'api') {
    lines.push('/tasks — View tasks, progress and cancellation controls', '/task_question — Open a pending task question (use the command supplied with the question)');
    if (['telegram', 'discord', 'line', 'slack'].includes(channel)) lines.push('/voice [on|auto|off] — Set voice replies', '/voices — Choose the agent voice');
    if (channel !== 'telegram') lines.push('/orch <token> — Use a supplied menu action; tokens expire');
  }
  if (channel === 'discord') lines.push('/ask <question> — Send a message to the agent');
  if (interactive && (channel === 'telegram' || (channel === 'discord' && !orchestration))) lines.push('/cli — Open the live terminal viewer');
  if (channel === 'api') lines.push('', 'REST controls (not slash commands):', 'PUT /api/v1/agents/:agentId/model — Change the model', 'GET/PATCH /api/v1/agents/:agentId/voice-settings — Read or update voice settings', 'GET /api/v1/agents/:agentId/sessions/:sessionId/tasks — List session tasks', 'POST /api/v1/agents/:agentId/sessions/:sessionId/tasks/:taskId/answer or /cancel — Answer or cancel a task');
  return 'Available commands\n\n' + lines.join('\n');
}
