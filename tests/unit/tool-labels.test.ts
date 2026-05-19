import {
  TOOL_LABELS,
  DEFAULT_TOOL_LABEL,
  CODING_TOOLS,
  getToolLabel,
  shortenPath,
  truncateDetail,
  extractToolDetail,
} from '../../src/utils/tool-labels';

describe('TOOL_LABELS', () => {
  it('contains all built-in Claude Code tools', () => {
    const expected = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite'];
    for (const name of expected) {
      expect(TOOL_LABELS[name]).toBeDefined();
      expect(TOOL_LABELS[name].emoji).toBeTruthy();
      expect(TOOL_LABELS[name].verb).toBeTruthy();
    }
  });

  it('contains MCP browser tools', () => {
    expect(TOOL_LABELS['mcp__browser__navigate']).toBeDefined();
    expect(TOOL_LABELS['mcp__browser__screenshot']).toBeDefined();
    expect(TOOL_LABELS['mcp__browser__click']).toBeDefined();
    expect(TOOL_LABELS['mcp__browser__type']).toBeDefined();
  });

  it('contains MCP gateway channel tools', () => {
    expect(TOOL_LABELS['mcp__gateway__telegram_reply']).toBeDefined();
    expect(TOOL_LABELS['mcp__gateway__discord_reply']).toBeDefined();
  });
});

describe('CODING_TOOLS', () => {
  it('contains write-type tools', () => {
    expect(CODING_TOOLS.has('Write')).toBe(true);
    expect(CODING_TOOLS.has('Edit')).toBe(true);
    expect(CODING_TOOLS.has('NotebookEdit')).toBe(true);
    expect(CODING_TOOLS.has('MultiEdit')).toBe(true);
  });

  it('does not include read-only tools', () => {
    expect(CODING_TOOLS.has('Read')).toBe(false);
    expect(CODING_TOOLS.has('Grep')).toBe(false);
    expect(CODING_TOOLS.has('Bash')).toBe(false);
  });
});

describe('getToolLabel', () => {
  it('returns label for known tool', () => {
    expect(getToolLabel('Read')).toEqual(TOOL_LABELS['Read']);
    expect(getToolLabel('Bash')).toEqual(TOOL_LABELS['Bash']);
  });

  it('returns DEFAULT_TOOL_LABEL for unknown tool', () => {
    expect(getToolLabel('UnknownTool')).toEqual(DEFAULT_TOOL_LABEL);
    expect(getToolLabel('mcp__some__unknown')).toEqual(DEFAULT_TOOL_LABEL);
  });

  it('returns label for MCP browser tool', () => {
    const label = getToolLabel('mcp__browser__navigate');
    expect(label.emoji).toBeTruthy();
    expect(label.verb).toBe('Opening');
  });
});

describe('shortenPath', () => {
  it('returns last 2 segments for long paths', () => {
    expect(shortenPath('/home/user/projects/src/utils/file.ts')).toBe('utils/file.ts');
    expect(shortenPath('/a/b/c/d')).toBe('c/d');
  });

  it('returns filename for 2-segment paths (not enough segments to slice)', () => {
    expect(shortenPath('src/file.ts')).toBe('file.ts');
  });

  it('returns filename for single segment', () => {
    expect(shortenPath('file.ts')).toBe('file.ts');
  });

  it('handles empty string', () => {
    expect(shortenPath('')).toBe('');
  });
});

describe('truncateDetail', () => {
  it('returns string as-is when within limits', () => {
    const s = 'short string';
    expect(truncateDetail(s)).toBe(s);
  });

  it('truncates by line count and appends ellipsis', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const result = truncateDetail(lines, 5);
    expect(result.endsWith('\n...')).toBe(true);
    expect(result.split('\n').length).toBeLessThanOrEqual(6);
  });

  it('truncates by char count and appends ellipsis', () => {
    const long = 'x'.repeat(400);
    const result = truncateDetail(long, 5, 300);
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(303);
  });

  it('filters empty lines', () => {
    const s = 'line1\n\n\nline2';
    const result = truncateDetail(s);
    expect(result).toBe('line1\nline2');
  });
});

describe('extractToolDetail', () => {
  describe('file tools', () => {
    it('formats Read with file path', () => {
      const result = extractToolDetail('Read', { file_path: '/home/user/src/api/router.ts' });
      expect(result).toContain('api/router.ts');
      expect(result).toContain('📖');
    });

    it('formats Edit with file path and description', () => {
      const result = extractToolDetail('Edit', { file_path: '/src/app.ts', description: 'fix null check' });
      expect(result).toContain('app.ts');
      expect(result).toContain('fix null check');
      expect(result).toContain('✏️');
    });

    it('formats Write with file path', () => {
      const result = extractToolDetail('Write', { file_path: '/src/new-file.ts' });
      expect(result).toContain('new-file.ts');
      expect(result).toContain('📝');
    });

    it('handles missing file_path gracefully', () => {
      const result = extractToolDetail('Read', {});
      expect(result).toContain('📖');
    });
  });

  describe('search tools', () => {
    it('formats Grep with pattern and path', () => {
      const result = extractToolDetail('Grep', { pattern: 'tool_use', path: '/src/agent' });
      expect(result).toContain('"tool_use"');
      expect(result).toContain('agent');
      expect(result).toContain('🔦');
    });

    it('formats Glob with pattern', () => {
      const result = extractToolDetail('Glob', { pattern: '**/*.ts' });
      expect(result).toContain('"**/*.ts"');
      expect(result).toContain('📂');
    });

    it('formats WebSearch with query', () => {
      const result = extractToolDetail('WebSearch', { query: 'typescript generics' });
      expect(result).toContain('"typescript generics"');
      expect(result).toContain('🔎');
    });
  });

  describe('execution tools', () => {
    it('formats Bash with description', () => {
      const result = extractToolDetail('Bash', { description: 'Run tests', command: 'npm test' });
      expect(result).toContain('Run tests');
      expect(result).toContain('💻');
    });

    it('formats Bash with command when no description', () => {
      const result = extractToolDetail('Bash', { command: 'npm test' });
      expect(result).toContain('npm test');
    });

    it('formats WebFetch with url', () => {
      const result = extractToolDetail('WebFetch', { url: 'https://example.com/api' });
      expect(result).toContain('https://example.com/api');
      expect(result).toContain('🌐');
    });
  });

  describe('agent tools', () => {
    it('formats Agent with description', () => {
      const result = extractToolDetail('Agent', { description: 'Search codebase' });
      expect(result).toContain('Search codebase');
      expect(result).toContain('🤖');
    });

    it('formats TodoWrite with active task', () => {
      const result = extractToolDetail('TodoWrite', {
        todos: [
          { content: 'Done task', status: 'completed' },
          { content: 'Active task', status: 'in_progress' },
          { content: 'Pending task', status: 'pending' },
        ],
      });
      expect(result).toContain('Active task');
      expect(result).toContain('📋');
    });

    it('formats TodoWrite with item count when no active task', () => {
      const result = extractToolDetail('TodoWrite', {
        todos: [
          { content: 'Task 1', status: 'pending' },
          { content: 'Task 2', status: 'pending' },
        ],
      });
      expect(result).toContain('2 items');
    });
  });

  describe('MCP tools', () => {
    it('formats mcp__browser__navigate with url', () => {
      const result = extractToolDetail('mcp__browser__navigate', { url: 'https://google.com' });
      expect(result).toContain('https://google.com');
      expect(result).toContain('🌐');
    });

    it('formats mcp__browser__click with selector', () => {
      const result = extractToolDetail('mcp__browser__click', { selector: '#submit-btn' });
      expect(result).toContain('#submit-btn');
      expect(result).toContain('🖱️');
    });

    it('formats mcp__browser__type with text', () => {
      const result = extractToolDetail('mcp__browser__type', { text: 'hello world' });
      expect(result).toContain('"hello world"');
      expect(result).toContain('⌨️');
    });

    it('formats mcp__gateway__telegram_reply with message', () => {
      const result = extractToolDetail('mcp__gateway__telegram_reply', { message: 'Hello!' });
      expect(result).toContain('Hello!');
      expect(result).toContain('✈️');
    });

    it('formats mcp__gateway__discord_reply with message', () => {
      const result = extractToolDetail('mcp__gateway__discord_reply', { message: 'Hi Discord' });
      expect(result).toContain('Hi Discord');
      expect(result).toContain('💬');
    });
  });

  describe('unknown tools', () => {
    it('uses fallback emoji for unknown tool', () => {
      const result = extractToolDetail('mcp__some__unknown', { description: 'doing something' });
      expect(result).toContain('🔧');
      expect(result).toContain('doing something');
    });

    it('uses ellipsis when no description for unknown tool', () => {
      const result = extractToolDetail('mcp__some__unknown', {});
      expect(result).toContain('...');
    });
  });
});
