import express from "express";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import request from "supertest";
import { createProjectsRouter } from "../../src/api/projects-router";
import {
  DiskSys,
  DiskUsage,
  duArgs,
  DuOutcome,
  parseDu,
  systemDiskSys,
} from "../../src/projects/disk";
import { StopLimiter, systemSys } from "../../src/projects/running";
import type { ApiKey } from "../../src/types";

const apiKeys: ApiKey[] = [
  { key: "k-admin", agents: "*", write: true, admin: true },
  { key: "k-read", agents: "*" },
  { key: "k-agent", agents: ["alfred"], write: true },
];
const as = (key: string) => ({ Authorization: `Bearer ${key}` });

let base: string;
let root: string;
const realPath = process.env.PATH;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "disk-")));
  root = path.join(base, "projects");
  fs.mkdirSync(root);
});
afterEach(() => {
  process.env.PATH = realPath;
  fs.rmSync(base, { recursive: true, force: true });
});

const mkProject = (name: string) =>
  fs.mkdirSync(path.join(root, name), { recursive: true });
const write = (file: string, kb: number) =>
  fs.writeFileSync(file, Buffer.alloc(kb * 1024, 1));

function appWith(disk: DiskUsage): express.Express {
  const a = express();
  a.use(express.json());
  a.use(
    "/api",
    createProjectsRouter(apiKeys, root, {
      sys: systemSys(),
      limiter: new StopLimiter(0),
      disk,
    }),
  );
  return a;
}

/** A du that records its calls and answers from a table, so tests control sizes, delays and failures. */
function fakeSys(
  answers: Record<string, DuOutcome | (() => Promise<DuOutcome>)>,
  calls: string[] = [],
): DiskSys {
  return {
    platform: "linux",
    async du(dir) {
      calls.push(path.basename(dir));
      const a = answers[path.basename(dir)];
      return typeof a === "function"
        ? a()
        : (a ?? { bytes: 0, exitCode: 0, timedOut: false });
    },
    statfs: async () => ({ total: 1000, used: 400, free: 500 }),
  };
}

const sized = (kb: number): DuOutcome => ({
  bytes: kb * 1024,
  exitCode: 0,
  timedOut: false,
});

describe("parseDu", () => {
  it("reads kilobytes from the first line and returns bytes", () => {
    expect(parseDu("12\t/some/dir\n")).toBe(12288);
    expect(parseDu("0\t/x\n")).toBe(0);
  });
  it('rejects anything that is not "<integer><TAB><path>"', () => {
    for (const bad of [
      "",
      "du: cannot access\n",
      "12 /x\n",
      "-1\t/x\n",
      "1.5\t/x\n",
      "012\t/x\n",
      "\t/x\n",
    ])
      expect(parseDu(bad)).toBeNull();
  });
});

describe("real du", () => {
  it("measures blocks, counts a hardlink once and does not follow a symlink", async () => {
    mkProject("app");
    const dir = path.join(root, "app");
    write(path.join(dir, "big"), 1024);
    const sys = systemDiskSys();
    const alone = (await sys.du(dir, 10_000)).bytes!;
    expect(alone).toBeGreaterThanOrEqual(1024 * 1024);

    fs.linkSync(path.join(dir, "big"), path.join(dir, "big-link"));
    expect((await sys.du(dir, 10_000)).bytes!).toBeLessThan(alone + 512 * 1024);

    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    write(path.join(outside, "huge"), 8192);
    fs.symlinkSync(outside, path.join(dir, "to-outside"));
    const withLink = await sys.du(dir, 10_000);
    expect(withLink.exitCode).toBe(0);
    expect(withLink.bytes!).toBeLessThan(alone + 512 * 1024);
  });

  it("asks du for a summary in kilobytes that stays on one filesystem, after --", () => {
    expect(duArgs("/p/app")).toEqual(["-s", "-k", "-x", "--", "/p/app"]);
  });

  it("runs the real du with exactly those arguments, no shell, and a trimmed environment", async () => {
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    const log = path.join(base, "argv.log");
    fs.writeFileSync(
      path.join(bin, "du"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\nenv > ${log}.env\nprintf '8\\t%s\\n' "$5"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${realPath}`;
    process.env.GATEWAY_SECRET_PROBE = "leak";
    mkProject("app");
    const dir = path.join(root, "app $(touch pwned)");
    fs.mkdirSync(dir);
    const out = await systemDiskSys().du(dir, 10_000);
    delete process.env.GATEWAY_SECRET_PROBE;
    expect(out).toEqual({ bytes: 8192, exitCode: 0, timedOut: false });
    expect(fs.readFileSync(log, "utf8").split("\n").slice(0, 5)).toEqual([
      "-s",
      "-k",
      "-x",
      "--",
      dir,
    ]);
    expect(fs.readFileSync(`${log}.env`, "utf8")).not.toContain(
      "GATEWAY_SECRET_PROBE",
    );
    expect(fs.existsSync(path.join(root, "pwned"))).toBe(false);
  });

  it("kills a du that outlives the timeout and says so", async () => {
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "du"), "#!/bin/sh\nexec sleep 30\n", {
      mode: 0o755,
    });
    process.env.PATH = `${bin}:${realPath}`;
    const t0 = Date.now();
    const out = await systemDiskSys().du(root, 150);
    expect(out).toMatchObject({ bytes: null, timedOut: true });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("reports a missing du as no total, not a crash", async () => {
    process.env.PATH = path.join(base, "empty");
    expect((await systemDiskSys().du(root, 1000)).bytes).toBeNull();
  });
});

describe("DiskUsage", () => {
  it("maps du outcomes to ok, partial and failed, and reads the disk from statfs", async () => {
    for (const n of ["a", "b", "c", "d"]) mkProject(n);
    const sys = fakeSys({
      a: sized(4),
      b: { bytes: null, exitCode: null, timedOut: true },
      c: { bytes: 2048, exitCode: 1, timedOut: false },
      d: { bytes: null, exitCode: 1, timedOut: false },
    });
    const r = await new DiskUsage(root, { sys }).get(false);
    expect(r.ok && r.value.projects).toEqual([
      { name: "a", bytes: 4096, state: "ok" },
      { name: "b", bytes: null, state: "partial" },
      { name: "c", bytes: 2048, state: "partial" },
      { name: "d", bytes: null, state: "failed" },
    ]);
    expect(r.ok && r.value).toMatchObject({
      supported: true,
      disk: { total: 1000, used: 400, free: 500 },
      cached: false,
    });
  });

  it("measures only listed projects: no symlink out of the root, no .deleting-, no bad names", async () => {
    mkProject("real");
    mkProject(".deleting-x");
    mkProject("bad name");
    fs.mkdirSync(path.join(base, "elsewhere"));
    fs.symlinkSync(path.join(base, "elsewhere"), path.join(root, "link"));
    fs.symlinkSync(path.join(root, "real"), path.join(root, "inner"));
    const calls: string[] = [];
    const r = await new DiskUsage(root, { sys: fakeSys({}, calls) }).get(false);
    expect(r.ok && r.value.projects.map((p) => p.name)).toEqual([
      "inner",
      "real",
    ]);
    expect(calls.sort()).toEqual(["real", "real"]);
  });

  it("runs at most three du at once", async () => {
    for (let i = 0; i < 8; i++) mkProject(`p${i}`);
    let now = 0;
    let max = 0;
    const sys = fakeSys({});
    sys.du = async () => {
      max = Math.max(max, ++now);
      await new Promise((r) => setTimeout(r, 20));
      now--;
      return sized(1);
    };
    await new DiskUsage(root, { sys }).get(false);
    expect(max).toBe(3);
  });

  it("stops starting new du once the overall budget is spent and passes each du the time left", async () => {
    for (const n of ["a", "b", "c", "d"]) mkProject(n);
    let clock = 0;
    const budgets: number[] = [];
    const sys = fakeSys({});
    sys.du = async (_d, ms) => {
      budgets.push(ms);
      clock += 40;
      return sized(1);
    };
    const r = await new DiskUsage(root, {
      sys,
      now: () => clock,
      projectTimeoutMs: 100,
      overallTimeoutMs: 100,
    }).get(false);
    expect(budgets).toEqual([100, 60, 20]);
    expect(r.ok && r.value.projects.map((p) => p.state)).toEqual([
      "ok",
      "ok",
      "ok",
      "partial",
    ]);
  });

  it("caches for 60 s, then measures again", async () => {
    mkProject("a");
    let clock = 1_000;
    const calls: string[] = [];
    const d = new DiskUsage(root, {
      sys: fakeSys({}, calls),
      now: () => clock,
    });
    const first = await d.get(false);
    clock += 59_000;
    const second = await d.get(false);
    expect([
      first.ok && first.value.cached,
      second.ok && second.value.cached,
      calls.length,
    ]).toEqual([false, true, 1]);
    expect(second.ok && first.ok && second.value.computedAt).toBe(
      first.ok && first.value.computedAt,
    );
    clock += 2_000;
    const third = await d.get(false);
    expect([third.ok && third.value.cached, calls.length]).toEqual([false, 2]);
  });

  it("shares one in-flight computation, refresh included", async () => {
    mkProject("a");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const d = new DiskUsage(root, {
      sys: fakeSys({ a: async () => (await gate, sized(1)) }, calls),
    });
    const all = [d.get(false), d.get(false), d.get(true)];
    await new Promise((r) => setTimeout(r, 30));
    release();
    const results = await Promise.all(all);
    expect(calls).toEqual(["a"]);
    expect(results.every((r) => r.ok && r.value.cached === false)).toBe(true);
  });

  it("refresh bypasses the cache once, then is served from the cache for 5 s", async () => {
    mkProject("a");
    let clock = 0;
    const calls: string[] = [];
    const d = new DiskUsage(root, {
      sys: fakeSys({}, calls),
      now: () => clock,
    });
    await d.get(false);
    clock += 1_000;
    const refreshed = await d.get(true);
    expect([refreshed.ok && refreshed.value.cached, calls.length]).toEqual([
      false,
      2,
    ]);
    clock += 3_000;
    const limited = await d.get(true);
    expect([limited.ok && limited.value.cached, calls.length]).toEqual([
      true,
      2,
    ]);
    clock += 2_100;
    await d.get(true);
    expect(calls.length).toBe(3);
  });

  it("does not cache a root that cannot be listed", async () => {
    fs.rmSync(root, { recursive: true });
    fs.writeFileSync(root, "file");
    const d = new DiskUsage(root, { sys: fakeSys({}) });
    expect((await d.get(false)).ok).toBe(false);
    fs.rmSync(root);
    fs.mkdirSync(root);
    mkProject("a");
    const r = await d.get(false);
    expect(r.ok && r.value.projects.length).toBe(1);
  });

  it("answers a root that does not exist with no projects and no disk", async () => {
    fs.rmSync(root, { recursive: true });
    const r = await new DiskUsage(root, { sys: fakeSys({}) }).get(false);
    expect(r.ok && r.value).toMatchObject({
      supported: true,
      disk: null,
      projects: [],
    });
  });

  it("reports win32 as unsupported without running anything", async () => {
    mkProject("a");
    const calls: string[] = [];
    const sys = { ...fakeSys({}, calls), platform: "win32" };
    const r = await new DiskUsage(root, { sys }).get(false);
    expect(r.ok && r.value).toMatchObject({
      supported: false,
      disk: null,
      projects: [],
      cached: false,
    });
    expect(calls).toEqual([]);
  });
});

describe("GET /api/v1/projects/disk", () => {
  it.each(["k-admin", "k-read", "k-agent"])(
    "answers key %s with the documented shape",
    async (key) => {
      mkProject("a");
      const res = await request(
        appWith(new DiskUsage(root, { sys: fakeSys({ a: sized(3) }) })),
      )
        .get("/api/v1/projects/disk")
        .set(as(key));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        supported: true,
        disk: { total: 1000, used: 400, free: 500 },
        projects: [{ name: "a", bytes: 3072, state: "ok" }],
        computedAt: expect.any(String),
        cached: false,
      });
      expect(new Date(res.body.computedAt).toISOString()).toBe(
        res.body.computedAt,
      );
    },
  );

  it("needs a key", async () => {
    const res = await request(
      appWith(new DiskUsage(root, { sys: fakeSys({}) })),
    ).get("/api/v1/projects/disk");
    expect(res.status).toBe(401);
  });

  it("is not taken for a project named disk: the static route wins and /:name routes still work", async () => {
    mkProject("disk");
    const a = appWith(new DiskUsage(root, { sys: fakeSys({}) }));
    expect(
      (await request(a).get("/api/v1/projects/disk").set(as("k-read"))).body,
    ).toHaveProperty("supported");
    const git = await request(a)
      .get("/api/v1/projects/disk/git")
      .set(as("k-read"));
    expect(git.body).not.toHaveProperty("supported");
    expect([409, 200]).toContain(git.status);
  });

  it("serves the cache, and ?refresh=1 measures again", async () => {
    mkProject("a");
    const calls: string[] = [];
    let clock = 0;
    const a = appWith(
      new DiskUsage(root, { sys: fakeSys({}, calls), now: () => clock }),
    );
    await request(a).get("/api/v1/projects/disk").set(as("k-read"));
    const cached = await request(a)
      .get("/api/v1/projects/disk")
      .set(as("k-read"));
    expect([cached.body.cached, calls.length]).toEqual([true, 1]);
    clock += 10_000;
    const fresh = await request(a)
      .get("/api/v1/projects/disk?refresh=1")
      .set(as("k-read"));
    expect([fresh.body.cached, calls.length]).toEqual([false, 2]);
  });

  it("answers supported:false with empty data on win32", async () => {
    mkProject("a");
    const a = express();
    a.use(
      "/api",
      createProjectsRouter(apiKeys, root, {
        sys: systemSys({ platform: "win32" }),
        limiter: new StopLimiter(0),
      }),
    );
    const res = await request(a).get("/api/v1/projects/disk").set(as("k-read"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      supported: false,
      disk: null,
      projects: [],
    });
  });

  it("with the default service, measures a real folder through real du", async () => {
    mkProject("real");
    write(path.join(root, "real", "f"), 512);
    const a = express();
    a.use(
      "/api",
      createProjectsRouter(apiKeys, root, {
        sys: systemSys({ platform: "linux" }),
        limiter: new StopLimiter(0),
      }),
    );
    const res = await request(a).get("/api/v1/projects/disk").set(as("k-read"));
    expect(res.body.projects[0]).toMatchObject({ name: "real", state: "ok" });
    expect(res.body.projects[0].bytes).toBeGreaterThanOrEqual(512 * 1024);
    expect(res.body.disk.total).toBeGreaterThan(res.body.disk.free - 1);
  });
});
