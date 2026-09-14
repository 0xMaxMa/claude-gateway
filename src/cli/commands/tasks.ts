import { CliConfigView, resolveUrlPlan, resolveReachableUrl, resolveKey, request } from '../http-client';
import { unknownFlagNames } from '../args';
import { printResult, writeCommandHelp } from '../output';

/** Human Task controls go through the running owner of task state. Never open
 * orchestration.db or replay worker commands from a second process. */
export async function runTasks(positionals: string[], flags: Record<string, string | boolean>, config: CliConfigView): Promise<number> {
  const [verb, taskId, ...extra] = positionals;
  if (flags.help === true || !verb) {
    writeCommandHelp(flags.help === true, 'tasks', 'inspect and cancel orchestration tasks',
      'claude-gateway tasks <list|show|watch|cancel> [task-id] --agent <id> --session <id>', [
        '  list              List active tasks; --all includes finished tasks',
        '  show <task-id>    Show task details and the complete retained result',
        '  watch [task-id]   Poll every 3 seconds; Ctrl+C stops watching only',
        '  cancel <task-id>  Request cancellation as the user (may report stopping)',
        '  --page <n> --page-size <n>  Zero-based list page; page size 1–100 (default 10)',
        '  --url --key --config --json  Use the standard gateway connection options',
        '  Requires a running gateway with orchestration enabled and session membership.',
      ]);
    return flags.help === true ? 0 : 1;
  }
  const allowed = new Set(['help','json','url','key','config','agent','session']);
  if (verb === 'list' || (verb === 'watch' && !taskId)) for (const name of ['all','page','page-size']) allowed.add(name);
  const unknown = unknownFlagNames(flags, allowed);
  if (unknown.length) throw Error(`Unknown flag(s): ${unknown.map(n => '--'+n).join(', ')}`);
  if (!['list','show','watch','cancel'].includes(verb) || extra.length || (verb === 'list' && taskId) || (['show','cancel'].includes(verb) && !taskId)) {
    throw Error('Usage: tasks list | show <task-id> | watch [task-id] | cancel <task-id>');
  }
  const agent = typeof flags.agent === 'string' ? flags.agent : '';
  const session = typeof flags.session === 'string' ? flags.session : '';
  if (!agent || !session) throw Error('Both --agent and --session are required');
  const page = flags.page === undefined ? 0 : Number(flags.page);
  const size = flags['page-size'] === undefined ? 10 : Number(flags['page-size']);
  if ((flags.page !== undefined && (typeof flags.page !== 'string' || !/^\d+$/.test(flags.page))) ||
      (flags['page-size'] !== undefined && (typeof flags['page-size'] !== 'string' || !/^\d+$/.test(flags['page-size']))) ||
      !Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(size) || size < 1 || size > 100) throw Error('Invalid task page or page size');
  if (flags.all !== undefined && ![true,false,'true','false'].includes(flags.all)) throw Error('--all must be true or false');
  const baseUrl = await resolveReachableUrl(resolveUrlPlan({ flagUrl: typeof flags.url === 'string' ? flags.url : undefined, env: process.env, config }));
  const key = resolveKey({ flagKey: typeof flags.key === 'string' ? flags.key : undefined, env: process.env, config });
  const base = `/v1/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/tasks`;
  const apiPath = taskId ? `${base}/${encodeURIComponent(taskId)}${verb === 'cancel' ? '/cancel' : ''}` : base;
  const controller = new AbortController();
  let stopped = false, wake: (() => void) | undefined;
  const stop = () => { stopped = true; controller.abort(); wake?.(); };
  if (verb === 'watch') { process.on('SIGINT', stop); process.on('SIGTERM', stop); }
  try {
    let fingerprint: string | undefined;
    do {
      if (stopped) break;
      const result = await request({ method: verb === 'cancel' ? 'POST' : 'GET', path: apiPath, baseUrl, key, signal: controller.signal,
        query: taskId ? undefined : { page: String(page), page_size: String(size), all: String(flags.all === true || flags.all === 'true') } });
      if (stopped) break;
      const next = JSON.stringify(result.data);
      if (next !== fingerprint) { printResult(result.data, flags.json === true); fingerprint = next; }
      const task = (result.data as { task?: { state: string } })?.task;
      if (verb !== 'watch' || (task && ['completed','failed','cancelled'].includes(task.state))) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, 3000);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    } while (!stopped);
    return 0;
  } catch (error) {
    if (stopped) return 0;
    throw error;
  } finally {
    if (verb === 'watch') { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  }
}
