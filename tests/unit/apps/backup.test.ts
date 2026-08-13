import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AppInstaller, InstallerCallbacks, JobState, AppBackupConfig } from '../../../src/apps/installer';
import { AppsRegistry, AppEntry } from '../../../src/apps/registry';
import { RegistryClient } from '../../../src/apps/registry-client';
import { ComposeSocket } from '../../../src/apps/compose-generator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
}

function makeCallbacks(): InstallerCallbacks {
  return {
    registerRoutes() {},
    deregisterRoutes() {},
    startSocket(_socketPath: string, _socket: ComposeSocket) { return Promise.resolve(); },
    stopSockets() {},
  };
}

function waitForJob(installer: AppInstaller, jobId: string, timeoutMs = 5000): Promise<JobState> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      const job = installer.getJob(jobId);
      if (!job) { clearInterval(interval); reject(new Error('job gone')); return; }
      if (job.status === 'completed' || job.status === 'failed') { clearInterval(interval); resolve(job); return; }
      if (Date.now() > deadline) { clearInterval(interval); reject(new Error(`timeout: ${job.status}`)); }
    }, 20);
  });
}

/**
 * A spawn mock that models just enough Docker/tar behavior for backup/restore:
 * `compose config --volumes` lists volumes; the host `tar czf` materializes the
 * archive; the host `tar xzf` re-materializes a staging tree; everything else
 * succeeds. `ps` is NOT answered here (that's the async seam).
 */
function makeCallLog() {
  const calls: string[][] = [];
  return { calls };
}

function backupSpawn(
  calls: string[][],
  opts: { volumes?: string[]; failVolumeTar?: boolean; restoreMeta?: Record<string, unknown> } = {},
) {
  const volumes = opts.volumes ?? ['data'];
  return jest.fn((cmd: string, args: string[], _o?: object) => {
    calls.push([cmd, ...args]);

    // docker compose -p <app> config --volumes
    if (args.includes('config') && args.includes('--volumes')) {
      return { stdout: volumes.join('\n') + '\n', stderr: '', status: 0 };
    }
    // Volume helper backup: docker run … tar czf /backup/<vol>.tar.gz …
    const isVolumeHelperTar =
      cmd === 'docker' && args.includes('run') && args.includes('czf') &&
      args.some((a) => a.startsWith('/backup/'));
    if (isVolumeHelperTar && opts.failVolumeTar) {
      return { stdout: '', stderr: 'mocked volume tar failure', status: 1 };
    }
    // Host outer tar (backup): tar czf <archivePath> -C <staging> .
    if (cmd === 'tar' && args[0] === 'czf') {
      fs.writeFileSync(args[1], 'FAKE-ARCHIVE');
      return { stdout: '', stderr: '', status: 0 };
    }
    // Host extract (restore): tar xzf <archive> -C <staging>
    if (cmd === 'tar' && args[0] === 'xzf') {
      const staging = args[args.indexOf('-C') + 1];
      fs.mkdirSync(path.join(staging, 'volumes'), { recursive: true });
      fs.mkdirSync(path.join(staging, 'config'), { recursive: true });
      const meta = opts.restoreMeta ?? {
        id: 'bk-restore', appName: 'x', appVersion: '1.0.0',
        createdAt: '2026-01-01T00:00:00.000Z', volumes, sizeBytes: 11,
      };
      fs.writeFileSync(path.join(staging, 'metadata.json'), JSON.stringify(meta));
      for (const v of (meta.volumes as string[] | undefined) ?? volumes) {
        fs.writeFileSync(path.join(staging, 'volumes', `${v}.tar.gz`), 'V');
      }
      fs.writeFileSync(path.join(staging, 'config', '.env'), 'SECRET=restored');
      return { stdout: '', stderr: '', status: 0 };
    }
    return { stdout: '', stderr: '', status: 0 };
  });
}

/** async seam: returning status 1 makes queryRuntimeStatus fall back to the stored status. */
const keepStoredAsyncSpawn = jest.fn(async () => ({ stdout: '', stderr: '', status: 1 }));

describe('AppInstaller — backup/restore', () => {
  let tmpDir: string;
  let appsDir: string;
  let backupsDir: string;
  let registry: AppsRegistry;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    appsDir = path.join(tmpDir, 'apps');
    backupsDir = path.join(tmpDir, 'app-backups');
    fs.mkdirSync(appsDir, { recursive: true });
    registry = new AppsRegistry(path.join(tmpDir, 'apps.json'));
  });

  function makeInstaller(spawnFn: jest.Mock, cfg?: AppBackupConfig) {
    return new AppInstaller(
      registry,
      new RegistryClient(),
      makeCallbacks(),
      spawnFn as unknown as ConstructorParameters<typeof AppInstaller>[3],
      appsDir,
      undefined,
      keepStoredAsyncSpawn as unknown as ConstructorParameters<typeof AppInstaller>[6],
      undefined, // housekeepingConfig
      cfg,
      backupsDir,
    );
  }

  async function seedApp(name: string, status: AppEntry['status'] = 'running'): Promise<AppEntry> {
    const appDir = path.join(appsDir, name);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, '.env'), 'DB_PASSWORD=secret\n');
    fs.writeFileSync(path.join(appDir, 'app.yaml'), `name: ${name}\nversion: 1.0.0\n`);
    const entry: AppEntry = {
      name, version: '1.0.0', commit: 'a'.repeat(40), githubUrl: '',
      installPath: appDir, ports: [], sockets: {},
      installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      status, source: 'registry', agentDeclaration: null,
    };
    await registry.upsert(entry);
    return entry;
  }

  function joinCalls(calls: string[][]): string[] {
    return calls.map((c) => c.join(' '));
  }

  // ── Backup ────────────────────────────────────────────────────────────────

  it('U-BK-1: backup tars each volume via the root helper, stops then restarts a running app', async () => {
    const { calls } = makeCallLog();
    const installer = makeInstaller(backupSpawn(calls, { volumes: ['data', 'cache'] }));
    await seedApp('shop', 'running');

    const job = await waitForJob(installer, installer.backup('shop'));
    expect(job.status).toBe('completed');
    expect(job.backup?.id).toBeTruthy();

    const flat = joinCalls(calls);
    // Permission-safe helper tar per volume (read-only mount, into /backup)
    expect(flat.some((l) => l.includes('docker run --rm -v shop_data:/data:ro') && l.includes('tar czf /backup/data.tar.gz'))).toBe(true);
    expect(flat.some((l) => l.includes('shop_cache:/data:ro') && l.includes('/backup/cache.tar.gz'))).toBe(true);
    // Stopped for consistency, restarted afterward
    expect(flat.some((l) => l.includes('compose -p shop stop'))).toBe(true);
    expect(flat.some((l) => l.includes('compose -p shop up'))).toBe(true);
    // Archive + sidecar landed
    const list = installer.listBackups('shop');
    expect(list).toHaveLength(1);
    expect(list[0].appVersion).toBe('1.0.0');
  });

  it('U-BK-2: a stopped app is neither stopped nor restarted for backup', async () => {
    const { calls } = makeCallLog();
    const installer = makeInstaller(backupSpawn(calls));
    await seedApp('idle', 'stopped');

    const job = await waitForJob(installer, installer.backup('idle'));
    expect(job.status).toBe('completed');
    const flat = joinCalls(calls);
    expect(flat.some((l) => l.includes('compose -p idle stop'))).toBe(false);
    expect(flat.some((l) => l.includes('compose -p idle up'))).toBe(false);
  });

  it('U-BK-3: a running app is ALWAYS restarted even when a volume tar fails (try/finally)', async () => {
    const { calls } = makeCallLog();
    const installer = makeInstaller(backupSpawn(calls, { failVolumeTar: true }));
    await seedApp('shop', 'running');

    const job = await waitForJob(installer, installer.backup('shop'));
    expect(job.status).toBe('failed');
    const flat = joinCalls(calls);
    expect(flat.some((l) => l.includes('compose -p shop stop'))).toBe(true);
    expect(flat.some((l) => l.includes('compose -p shop up'))).toBe(true); // restarted in finally
  });

  it('U-BK-4: never uses host cp/chown/sudo on volume data (helper-container tar only)', async () => {
    const { calls } = makeCallLog();
    const installer = makeInstaller(backupSpawn(calls));
    await seedApp('shop', 'running');
    await waitForJob(installer, installer.backup('shop'));

    for (const c of calls) {
      expect(c[0]).not.toBe('cp');
      expect(c[0]).not.toBe('chown');
      expect(c[0]).not.toBe('sudo');
    }
  });

  it('U-BK-DEFAULTDIR: with no backupsDir injected, archives land under <appsDir>/.backups/<app>', async () => {
    const { calls } = makeCallLog();
    // Construct without the injected backupsDir so the default (derived from
    // appsDir) is exercised — locks the user-specified `apps/.backups/<app>` layout.
    const installer = new AppInstaller(
      registry,
      new RegistryClient(),
      makeCallbacks(),
      backupSpawn(calls, { volumes: ['data'] }) as unknown as ConstructorParameters<typeof AppInstaller>[3],
      appsDir,
      undefined,
      keepStoredAsyncSpawn as unknown as ConstructorParameters<typeof AppInstaller>[6],
      undefined, // housekeepingConfig
      undefined, // appBackupConfig
      // no backupsDir arg → default under <appsDir>/.backups
    );
    await seedApp('shop', 'stopped');

    const job = await waitForJob(installer, installer.backup('shop'));
    expect(job.status).toBe('completed');

    const defaultDir = path.join(appsDir, '.backups', 'shop');
    expect(fs.existsSync(path.join(defaultDir, `${job.backup?.id}.tar.gz`))).toBe(true);
    expect(fs.existsSync(path.join(defaultDir, `${job.backup?.id}.json`))).toBe(true);
    expect(installer.listBackups('shop')).toHaveLength(1);
  });

  it('U-BK-5: retention keeps only the N most recent backups', async () => {
    const { calls } = makeCallLog();
    const installer = makeInstaller(backupSpawn(calls), { retention: 2 });
    await seedApp('shop', 'stopped');

    for (let i = 0; i < 4; i++) {
      await waitForJob(installer, installer.backup('shop'));
      // ensure distinct createdAt ordering across archives
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(installer.listBackups('shop')).toHaveLength(2);
  });

  // ── Restore ───────────────────────────────────────────────────────────────

  it('U-RS-1: restore untars each volume into a live mount, restores .env, and starts the app', async () => {
    const { calls } = makeCallLog();
    const installer = makeInstaller(backupSpawn(calls, { volumes: ['data'] }));
    await seedApp('shop', 'stopped');
    // seed an archive to restore
    const dir = path.join(backupsDir, 'shop');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bk1.tar.gz'), 'ARCHIVE');

    const job = await waitForJob(installer, installer.restore('shop', 'bk1'));
    expect(job.status).toBe('completed');
    const flat = joinCalls(calls);
    // read-write mount + untar
    expect(flat.some((l) => l.includes('-v shop_data:/data ') && l.includes('tar xzf /backup/data.tar.gz'))).toBe(true);
    expect(flat.some((l) => l.includes('compose -p shop up'))).toBe(true);
    // .env restored from the archive
    expect(fs.readFileSync(path.join(appsDir, 'shop', '.env'), 'utf-8')).toContain('SECRET=restored');
  });

  it('U-RS-2: restore across a differing app version warns but proceeds', async () => {
    const { calls } = makeCallLog();
    const installer = makeInstaller(
      backupSpawn(calls, {
        restoreMeta: { id: 'old', appName: 'shop', appVersion: '9.9.9', createdAt: '2026-01-01T00:00:00.000Z', volumes: ['data'], sizeBytes: 5 },
      }),
    );
    await seedApp('shop', 'stopped'); // installed version 1.0.0
    const dir = path.join(backupsDir, 'shop');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.tar.gz'), 'ARCHIVE');

    const job = await waitForJob(installer, installer.restore('shop', 'old'));
    expect(job.status).toBe('completed');
    expect(job.logs.join('\n')).toMatch(/schema\/migration mismatch/i);
  });

  it('U-RS-3: restoring a non-existent backup fails cleanly', async () => {
    const { calls } = makeCallLog();
    const installer = makeInstaller(backupSpawn(calls));
    await seedApp('shop', 'stopped');
    const job = await waitForJob(installer, installer.restore('shop', 'nope'));
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/not found/i);
  });

  it('U-SEC-1: a traversal app name never escapes the backups dir (delete/list guard)', () => {
    const { calls } = makeCallLog();
    const installer = makeInstaller(backupSpawn(calls));
    // A `%2F`-smuggled name that path.join would otherwise resolve outside the tree.
    expect(() => installer.deleteBackup('../../etc', 'x')).toThrow(/Invalid app name/i);
    expect(() => installer.listBackups('../../etc')).toThrow(/Invalid app name/i);
    // Nothing was created outside backupsDir.
    expect(fs.existsSync(path.join(tmpDir, 'etc'))).toBe(false);
  });

  // ── Auto-backup hooks ───────────────────────────────────────────────────────

  it('U-HOOK-1: uninstall auto-backs up first when enabled', async () => {
    const { calls } = makeCallLog();
    const installer = makeInstaller(backupSpawn(calls), { autoBackupBeforeUninstall: true });
    await seedApp('shop', 'stopped');

    await installer.uninstall('shop');
    const flat = joinCalls(calls);
    // helper-tar ran before the teardown
    expect(flat.some((l) => l.includes('tar czf /backup/data.tar.gz'))).toBe(true);
    // a backup archive persisted despite the app being removed
    expect(installer.listBackups('shop').length).toBeGreaterThanOrEqual(1);
  });

  it('U-HOOK-2: uninstall skips auto-backup when disabled', async () => {
    const { calls } = makeCallLog();
    const installer = makeInstaller(backupSpawn(calls), { autoBackupBeforeUninstall: false });
    await seedApp('shop', 'stopped');

    await installer.uninstall('shop');
    const flat = joinCalls(calls);
    expect(flat.some((l) => l.includes('tar czf /backup/'))).toBe(false);
  });
});
