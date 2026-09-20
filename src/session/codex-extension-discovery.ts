import { spawn } from 'child_process';
import { codexPolicyArgs } from './codex-policy';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, userInfo } from 'os';

export interface NativeCodexSkill { name: string; description: string; path: string; enabled: boolean; pluginId?: string | null; }
export interface NativeCodexExtensions { skills: NativeCodexSkill[]; config: Record<string, any>; plugins?: { name: string; root: string }[]; pluginIds?: string[]; }

/** Ask the installed CLI, rather than guessing cache versions or enabling every
 * directory in its cache. No thread is created and no model request is sent. */
export function inspectCodexExtensions(bin: string, cwd: string, env = process.env, container?: string): Promise<NativeCodexExtensions> {
  return new Promise((resolve, reject) => {
    const args = codexPolicyArgs();
    const index = args.indexOf('features.plugins=false');
    if (index >= 1) args.splice(index - 1, 2);
    const nativeArgs = [...args, 'app-server', '--listen', 'stdio://'];
    const child = container ? spawn('docker', ['exec', '-i', '--workdir', '/workspace', '--user', String(userInfo().uid), '-e', `HOME=${homedir()}`, container, bin, ...nativeArgs], { env, stdio: 'pipe' })
      : spawn(bin, nativeArgs, { cwd, env, stdio: 'pipe' });
    let sequence = 0, buffer = '', bytes = 0, settled = false;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const finish = (error?: Error, result?: NativeCodexExtensions) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill('SIGTERM');
      const kill = setTimeout(() => { child.kill('SIGKILL'); child.unref(); }, 1000);
      kill.unref(); child.once('close', () => clearTimeout(kill));
      for (const request of pending.values()) request.reject(new Error('CODEX_EXTENSION_DISCOVERY_CLOSED'));
      pending.clear();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('CODEX_EXTENSION_DISCOVERY_TIMEOUT')), 15000);
    child.on('error', () => finish(new Error('CODEX_EXTENSION_DISCOVERY_UNAVAILABLE')));
    child.on('close', () => finish(new Error('CODEX_EXTENSION_DISCOVERY_CLOSED')));
    child.stdin.on('error', () => finish(new Error('CODEX_EXTENSION_DISCOVERY_CLOSED')));
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk); buffer += chunk;
      if (bytes > 8 * 1024 * 1024) return finish(new Error('CODEX_EXTENSION_DISCOVERY_TOO_LARGE'));
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        const request = pending.get(event.id);
        if (!request || event.method) continue;
        pending.delete(event.id);
        // Native diagnostics can contain credentials. Never propagate their text.
        if (event.error) request.reject(new Error('CODEX_EXTENSION_DISCOVERY_REJECTED'));
        else request.resolve(event.result);
      }
    });
    const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    void (async () => {
      await rpc('initialize', { clientInfo: { name: 'gateway_extensions', version: '1' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      const config = (await rpc('config/read', { cwd, includeLayers: false })).config;
      if (!config) throw new Error('CODEX_EXTENSION_CONFIG_UNAVAILABLE');
      const listing = await rpc('skills/list', { cwds: [cwd], forceReload: true });
      const skills: NativeCodexSkill[] = (listing.data ?? []).flatMap((entry: any) => entry.skills ?? []).filter((skill: any) => skill.enabled === true && typeof skill.path === 'string');
      // Remote installed plugins can be omitted from skills/list until explicitly
      // selected. plugin/read gives their installed paths without a model call.
      const plugins = await rpc('plugin/installed', { cwds: [cwd] });
      const installed: { name: string; root: string }[] = [];
      const pluginIds: string[] = [];
      for (const marketplace of plugins.marketplaces ?? []) {
        for (const plugin of marketplace.plugins ?? []) {
          if (!plugin.installed || !plugin.enabled || plugin.disabledReason) continue;
          pluginIds.push(plugin.id);
          // A remote catalog may return null skill paths even after its exact
          // published version has been materialized locally. Never choose an
          // arbitrary cached version or scan disabled/uninstalled packages.
          const version = plugin.localVersion ?? plugin.version;
          const parts = [marketplace.name, plugin.name, version];
          const root = plugin.source?.type === 'local' ? plugin.source.path : parts.every(part => typeof part === 'string' && /^[\w.-]+$/.test(part) && part !== '.' && part !== '..')
            ? join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'), 'plugins', 'cache', ...parts) : undefined;
          if (root && (container || existsSync(join(root, '.codex-plugin', 'plugin.json')))) installed.push({ name: plugin.name, root });
          const detail = await rpc('plugin/read', { pluginName: plugin.name, marketplacePath: marketplace.path ?? null, remoteMarketplaceName: marketplace.path ? null : marketplace.name });
          for (const skill of detail.plugin?.skills ?? []) {
            if (skill.enabled === true && typeof skill.path === 'string' && !skills.some(entry => entry.path === skill.path)) skills.push({ ...skill, pluginId: plugin.id });
          }
        }
      }
      finish(undefined, { config, skills, plugins: installed, pluginIds });
    })().catch(() => finish(new Error('CODEX_EXTENSION_DISCOVERY_UNAVAILABLE')));
  });
}
