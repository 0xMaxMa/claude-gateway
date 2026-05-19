export interface ToolLabel {
  emoji: string;
  verb: string;
}

export const TOOL_LABELS: Record<string, ToolLabel> = {
  Read:         { emoji: '📖', verb: 'Reading' },
  Edit:         { emoji: '✏️', verb: 'Editing' },
  Write:        { emoji: '📝', verb: 'Writing' },
  MultiEdit:    { emoji: '❤️‍🔥', verb: 'Editing' },
  NotebookEdit: { emoji: '📕', verb: 'Editing notebook' },
  Grep:         { emoji: '🔦', verb: 'Searching for' },
  Glob:         { emoji: '📂', verb: 'Finding files' },
  Bash:         { emoji: '💻', verb: 'Running' },
  WebFetch:     { emoji: '🌐', verb: 'Fetching' },
  WebSearch:    { emoji: '🔎', verb: 'Searching' },
  Agent:        { emoji: '🤖', verb: 'Running agent' },
  Task:         { emoji: '👉', verb: 'Running task' },
  TodoWrite:    { emoji: '📋', verb: 'Updating tasks' },
  // MCP tools
  'mcp__browser__navigate':        { emoji: '🌐', verb: 'Opening' },
  'mcp__browser__screenshot':      { emoji: '📸', verb: 'Screenshot' },
  'mcp__browser__click':           { emoji: '🖱️', verb: 'Clicking' },
  'mcp__browser__type':            { emoji: '⌨️', verb: 'Typing' },
  'mcp__browser__scroll':          { emoji: '↕️', verb: 'Scrolling' },
  'mcp__browser__hover':           { emoji: '🖱️', verb: 'Hovering' },
  'mcp__gateway__telegram_reply':  { emoji: '✈️', verb: 'Replying on Telegram' },
  'mcp__gateway__discord_reply':   { emoji: '💬', verb: 'Replying on Discord' },
};

export const DEFAULT_TOOL_LABEL: ToolLabel = { emoji: '🔧', verb: 'Using tool' };

export function getToolLabel(name: string): ToolLabel {
  return TOOL_LABELS[name] ?? DEFAULT_TOOL_LABEL;
}

export const CODING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

export function shortenPath(p: string): string {
  const parts = p.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || p;
}

export function truncateDetail(s: string, maxLines = 5, maxChars = 300): string {
  const lines = s.split('\n').filter(l => l.trim());
  const trimmedByLines = lines.length > maxLines;
  const kept = lines.slice(0, maxLines);
  let result = kept.join('\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '...';
  } else if (trimmedByLines) {
    result += '\n...';
  }
  return result;
}

export function extractToolDetail(name: string, input: Record<string, unknown>): string {
  const { emoji, verb } = getToolLabel(name);

  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const file = typeof input.file_path === 'string' ? shortenPath(input.file_path) : '';
      const desc = typeof input.description === 'string' ? ` — ${input.description}` : '';
      return truncateDetail(`${emoji} ${verb}: ${file}${desc}`);
    }
    case 'Grep': {
      const pattern = typeof input.pattern === 'string' ? `"${input.pattern}"` : '';
      const path = typeof input.path === 'string' ? ` in ${shortenPath(input.path)}` : '';
      return truncateDetail(`${emoji} ${verb}: ${pattern}${path}`);
    }
    case 'Glob': {
      const pattern = typeof input.pattern === 'string' ? `"${input.pattern}"` : '';
      return truncateDetail(`${emoji} ${verb}: ${pattern}`);
    }
    case 'Bash': {
      const desc = typeof input.description === 'string' ? input.description : '';
      const cmd = typeof input.command === 'string' ? input.command : '';
      return truncateDetail(`${emoji} ${verb}: ${desc || cmd}`);
    }
    case 'WebFetch':
    case 'mcp__browser__navigate': {
      const url = typeof input.url === 'string' ? input.url : '';
      return truncateDetail(`${emoji} ${verb}: ${url}`);
    }
    case 'WebSearch': {
      const query = typeof input.query === 'string' ? input.query : '';
      return truncateDetail(`${emoji} ${verb}: "${query}"`);
    }
    case 'Agent':
    case 'Task': {
      const desc = typeof input.description === 'string' ? input.description : '';
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      return truncateDetail(`${emoji} ${verb}: ${desc || prompt}`);
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos as { content?: string; status?: string }[] : [];
      const active = todos.find(t => t.status === 'in_progress');
      const detail = active?.content ?? `${todos.length} items`;
      return truncateDetail(`${emoji} ${verb}: ${detail}`);
    }
    case 'mcp__browser__click': {
      const selector = typeof input.selector === 'string' ? input.selector : '';
      return truncateDetail(`${emoji} ${verb}: ${selector}`);
    }
    case 'mcp__browser__type': {
      const text = typeof input.text === 'string' ? input.text : '';
      return truncateDetail(`${emoji} ${verb}: "${text}"`);
    }
    case 'mcp__gateway__telegram_reply':
    case 'mcp__gateway__discord_reply': {
      const msg = typeof input.message === 'string' ? input.message : '';
      return truncateDetail(`${emoji} ${verb}: ${msg}`);
    }
    default: {
      const desc = typeof input.description === 'string' ? input.description : '';
      return truncateDetail(`${emoji} ${verb}: ${desc || '...'}`);
    }
  }
}
