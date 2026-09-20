import type { SafemodeCli } from './native';

/** Quoting only: no shell expansion, substitution, globbing or execution. */
export function splitNativeParams(text: string): string[] {
  if (!text.trim() || text.length > 100000 || text.includes('\0')) throw new Error('Invalid --params value');
  const args: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && quote !== "'") {
      if (++i === text.length) throw new Error('Unfinished escape in --params');
      const next = text[i];
      if (quote === '"' && !['"', '\\', '$', '`', '\n'].includes(next)) word += '\\';
      if (next !== '\n') word += next;
      started = true;
    } else if (quote) {
      if (ch === quote) quote = ''; else word += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) {
      if (started) { args.push(word); word = ''; started = false; }
    } else { word += ch; started = true; }
  }
  if (quote) throw new Error('Unclosed quote in --params');
  if (started) args.push(word);
  return args;
}

/** Identity/lifecycle switches remain owned by safemode; other options pass through. */
export function inspectNativeParams(cli: SafemodeCli, args: string[]): { args: string[]; resumeId?: string } {
  const remaining: string[] = [];
  let resumeId: string | undefined;
  const forbidden = cli === 'codex'
    ? ['exec', 'e', 'review', 'fork', 'app-server', 'exec-server', 'login', 'logout', 'mcp', 'plugin', 'agents', 'queue', 'archive', 'delete', 'unarchive', 'migrate-rollouts', 'remote-control', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'cloud', 'features', 'help', '--last', '--remote', '--cd', '-C']
    : ['--print', '-p', '--continue', '-c', '--fork-session', '--session-id', '--resume-session-at', '--no-session-persistence', '--remote'];
  const valueFlags = cli === 'codex'
    ? ['-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '--enable', '--disable', '--image', '-i', '--add-dir']
    : ['--model', '--permission-mode', '--tools', '--allowedTools', '--disallowedTools', '--mcp-config', '--settings', '--setting-sources', '--system-prompt', '--append-system-prompt', '--add-dir', '--agent', '--agents', '--effort'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], flag = arg.split('=')[0];
    if ((cli === 'claude' && /^-[rcp].+/.test(arg) && !arg.startsWith('-r=')) || (cli === 'codex' && /^-C.+/.test(arg))) throw new Error('Use explicit lifecycle flags; combined short switches are unsupported in --params');
    if (arg === '--' || forbidden.includes(flag)) throw new Error('Native lifecycle, workspace and remote switches are not supported in --params; use --prompt for prompt text');
    if ((cli === 'codex' && arg === 'resume') || (cli === 'claude' && ['--resume', '-r'].includes(flag))) {
      const id = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      if (resumeId || !id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Native resume requires exactly one explicit session UUID');
      resumeId = id.toLowerCase();
    } else {
      remaining.push(arg);
      if (valueFlags.includes(arg)) {
        if (args[i + 1] === undefined || args[i + 1].startsWith('-')) throw new Error('Missing native option value in --params');
        remaining.push(args[++i]);
      }
    }
  }
  return { args: remaining, resumeId };
}
