import express from "express";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import request from "supertest";
import { createProjectsRouter } from "../../src/api/projects-router";
import { markProjectDeleting } from "../../src/projects/chat";
import { DiskUsage, systemDiskSys } from "../../src/projects/disk";
import { setProjectsLogger } from "../../src/projects/log";
import { StopLimiter, systemSys } from "../../src/projects/running";
import { StartGuard } from "../../src/projects/start";
import type { ApiKey, Logger } from "../../src/types";

const apiKeys: ApiKey[] = [
  { key: "k-admin", agents: "*", write: true, admin: true },
  { key: "k-write", agents: "*", write: true },
];
const ADMIN = { Authorization: "Bearer k-admin" };

let base: string;
let root: string;
let child: ChildProcess | undefined;
let info: jest.Mock;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-")));
  root = path.join(base, "projects");
  fs.mkdirSync(root);
  info = jest.fn();
  setProjectsLogger({
    debug: jest.fn(),
    info,
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger);
});
afterEach(() => {
  jest.restoreAllMocks();
  setProjectsLogger(undefined);
  child?.kill("SIGKILL");
  child = undefined;
  fs.rmSync(base, { recursive: true, force: true });
});

/** Writes `files` (relative path -> content) under the project; a trailing slash makes an empty folder. */
function project(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (rel.endsWith("/")) {
      fs.mkdirSync(p, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

const KB = (n: number) => "x".repeat(n * 1024);
const node = (extra: Record<string, string> = {}) => ({
  "package.json": "{}",
  "src/index.js": "1",
  "node_modules/dep/index.js": KB(64),
  ...extra,
});
const python = (extra: Record<string, string> = {}) => ({
  "requirements.txt": "flask\n",
  "app.py": "1",
  ".venv/pyvenv.cfg": "home = /usr/bin\n",
  ".venv/lib/blob": KB(64),
  ...extra,
});

interface AppOpts {
  chatTurnActive?: (name: string) => boolean;
  starts?: StartGuard;
  disk?: DiskUsage;
}

function appWith(opts: AppOpts = {}): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/api",
    createProjectsRouter(apiKeys, root, {
      sys: systemSys(),
      limiter: new StopLimiter(0),
      chatTurnActive: opts.chatTurnActive ?? (() => false),
      starts: opts.starts,
      disk: opts.disk,
    }),
  );
  return app;
}

const preview = (app: express.Express) =>
  request(app).get("/api/v1/projects/cleanup").set(ADMIN);
const clean = (app: express.Express, body: unknown) =>
  request(app)
    .post("/api/v1/projects/cleanup")
    .set(ADMIN)
    .send(body as object);
const exists = (...p: string[]) => fs.existsSync(path.join(root, ...p));

describe("GET /api/v1/projects/cleanup", () => {
  it("lists each eligible folder with its kind, size and restore command, and changes nothing", async () => {
    project("web", node({ "package-lock.json": "{}" }));
    project("api", python());
    project("plain", { "README.md": "x" });
    const res = await preview(appWith());
    expect(res.status).toBe(200);
    expect(res.body.supported).toBe(true);
    expect(
      res.body.projects.map(
        (p: {
          name: string;
          skipped: unknown;
          folders: { path: string; kind: string; restore: string | null }[];
        }) => [
          p.name,
          p.skipped,
          p.folders.map((f) => [f.path, f.kind, f.restore]),
        ],
      ),
    ).toEqual([
      [
        "api",
        null,
        [
          [
            ".venv",
            "venv",
            "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
          ],
        ],
      ],
      ["web", null, [["node_modules", "node_modules", "npm ci"]]],
    ]);
    const sizes = res.body.projects.flatMap(
      (p: { folders: { bytes: number }[] }) => p.folders.map((f) => f.bytes),
    );
    expect(sizes.every((b: number) => b >= 64 * 1024)).toBe(true);
    expect(res.body.totalBytes).toBe(sizes[0] + sizes[1]);
    expect(Number.isNaN(Date.parse(res.body.computedAt))).toBe(false);
    expect(exists("web", "node_modules", "dep", "index.js")).toBe(true);
    expect(exists("api", ".venv", "pyvenv.cfg")).toBe(true);
  });

  it.each([
    ["node_modules without package.json", { "node_modules/dep/a.js": "1" }],
    [
      "package.json that is a folder",
      { "package.json/": "", "node_modules/dep/a.js": "1" },
    ],
    [
      "node_modules that is a file",
      { "package.json": "{}", node_modules: "1" },
    ],
    [".venv without a Python file at the root", { ".venv/pyvenv.cfg": "x" }],
    [
      ".venv without pyvenv.cfg",
      { "pyproject.toml": "", ".venv/lib/blob": "1" },
    ],
    ["venv without pyvenv.cfg", { "setup.py": "", "venv/lib/blob": "1" }],
    [
      "a nested node_modules",
      { "sub/package.json": "{}", "sub/node_modules/a.js": "1" },
    ],
    [
      "build output",
      {
        "package.json": "{}",
        "dist/a.js": "1",
        ".next/a": "1",
        "target/a": "1",
      },
    ],
  ])("does not list %s", async (_case, files) => {
    project("p", files as Record<string, string>);
    const res = await preview(appWith());
    expect(res.body.projects).toEqual([]);
    expect(res.body.totalBytes).toBe(0);
  });

  it.each([
    [
      "requirements-dev.txt",
      "venv",
      { "requirements-dev.txt": "", "venv/pyvenv.cfg": "x" },
      null,
    ],
    ["Pipfile", ".venv", { Pipfile: "", ".venv/pyvenv.cfg": "x" }, null],
    [
      "Pipfile.lock",
      ".venv",
      { "Pipfile.lock": "", ".venv/pyvenv.cfg": "x" },
      null,
    ],
    [
      "pyproject.toml and uv.lock",
      ".venv",
      { "pyproject.toml": "", "uv.lock": "", ".venv/pyvenv.cfg": "x" },
      "uv sync",
    ],
    [
      "poetry.lock",
      ".venv",
      { "poetry.lock": "", ".venv/pyvenv.cfg": "x" },
      "poetry install",
    ],
    [
      "requirements.txt beside venv",
      "venv",
      { "requirements.txt": "", "venv/pyvenv.cfg": "x" },
      "python3 -m venv venv && venv/bin/pip install -r requirements.txt",
    ],
    [
      "pnpm-lock.yaml",
      "node_modules",
      node({ "pnpm-lock.yaml": "" }),
      "pnpm install",
    ],
    ["yarn.lock", "node_modules", node({ "yarn.lock": "" }), "yarn install"],
    ["bun.lock", "node_modules", node({ "bun.lock": "" }), "bun install"],
    ["bun.lockb", "node_modules", node({ "bun.lockb": "" }), "bun install"],
    ["no lockfile", "node_modules", node(), "npm install"],
  ])("lists a project with %s as %s", async (_case, folder, files, restore) => {
    project("p", files as Record<string, string>);
    const res = await preview(appWith());
    expect(
      res.body.projects[0].folders.map(
        (f: { path: string; restore: string | null }) => [f.path, f.restore],
      ),
    ).toEqual([[folder, restore]]);
  });

  it("does not list a symlinked node_modules, or a project that is a symlink alias", async () => {
    const outside = path.join(base, "outside");
    fs.mkdirSync(path.join(outside, "dep"), { recursive: true });
    project("p", { "package.json": "{}" });
    fs.symlinkSync(outside, path.join(root, "p", "node_modules"));
    project("real", node());
    fs.symlinkSync(path.join(root, "real"), path.join(root, "alias"));
    const res = await preview(appWith());
    expect(res.body.projects.map((p: { name: string }) => p.name)).toEqual([
      "real",
    ]);
  });

  it("does not list a folder on another filesystem than its project", async () => {
    const dir = project("p", node());
    const realLstat = fs.promises.lstat.bind(fs.promises);
    jest.spyOn(fs.promises, "lstat").mockImplementation((async (
      p: fs.PathLike,
    ) => {
      const st = await realLstat(p);
      if (String(p) === path.join(dir, "node_modules"))
        return Object.assign(st, { dev: st.dev + 1 });
      return st;
    }) as typeof fs.promises.lstat);
    expect((await preview(appWith())).body.projects).toEqual([]);
  });

  it("still lists skipped projects with their folders and reason, and leaves them out of totalBytes", async () => {
    project("busy", node());
    project("deleting", node());
    project("free", node());
    const release = markProjectDeleting(path.join(root, "deleting"))!;
    try {
      const res = await preview(
        appWith({ chatTurnActive: (n) => n === "busy" }),
      );
      expect(
        res.body.projects.map(
          (p: { name: string; skipped: string | null; folders: unknown[] }) => [
            p.name,
            p.skipped,
            p.folders.length,
          ],
        ),
      ).toEqual([
        ["busy", "chat_active", 1],
        ["deleting", "deleting", 1],
        ["free", null, 1],
      ]);
      expect(res.body.totalBytes).toBe(res.body.projects[2].folders[0].bytes);
    } finally {
      release();
    }
  });

  it("marks a project running while something listens from inside it", async () => {
    const dir = project("server", node());
    child = spawn(
      process.execPath,
      ["-e", "require('net').createServer().listen(0, '127.0.0.1')"],
      { cwd: dir, stdio: "ignore" },
    );
    const app = appWith();
    let skipped: string | null = null;
    for (let i = 0; i < 50 && skipped === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
      skipped = (await preview(app)).body.projects[0].skipped;
    }
    expect(skipped).toBe("running");
  });

  it("marks a project running while a start is booting in it", async () => {
    const dir = project("booting", node());
    const starts = new StartGuard();
    let release!: () => void;
    const booting = starts.run(
      dir,
      () => new Promise<void>((r) => (release = r)),
    );
    try {
      expect(
        (await preview(appWith({ starts }))).body.projects[0].skipped,
      ).toBe("running");
    } finally {
      release();
      await booting;
    }
  });

  it("answers supported:false with nothing listed on win32", async () => {
    project("web", node());
    const disk = new DiskUsage(root, { sys: systemDiskSys("win32") });
    const res = await preview(appWith({ disk }));
    expect([
      res.status,
      res.body.supported,
      res.body.projects,
      res.body.totalBytes,
    ]).toEqual([200, false, [], 0]);
  });
});

describe("POST /api/v1/projects/cleanup", () => {
  it("renames each folder to a sibling .pod-cleanup- folder, removes it, keeps the rest of the project, and logs it", async () => {
    project("web", node());
    project("api", python());
    const renames: [string, string][] = [];
    const realRename = fs.promises.rename.bind(fs.promises);
    jest.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      renames.push([String(from), String(to)]);
      return realRename(from, to);
    });
    const res = await clean(appWith(), {
      items: [
        { project: "web", folders: ["node_modules"] },
        { project: "api", folders: [".venv"] },
      ],
    });
    expect(res.status).toBe(200);
    expect(
      res.body.results.map(
        (r: { project: string; folder: string; state: string }) => [
          r.project,
          r.folder,
          r.state,
        ],
      ),
    ).toEqual([
      ["web", "node_modules", "removed"],
      ["api", ".venv", "removed"],
    ]);
    expect(
      res.body.results.every((r: { bytes: number }) => r.bytes >= 64 * 1024),
    ).toBe(true);
    expect(res.body.freedBytes).toBe(
      res.body.results[0].bytes + res.body.results[1].bytes,
    );
    expect(
      renames.map(([from, to]) => [
        from,
        path.dirname(to) === path.dirname(from),
        path.basename(to).startsWith(".pod-cleanup-"),
      ]),
    ).toEqual([
      [path.join(root, "web", "node_modules"), true, true],
      [path.join(root, "api", ".venv"), true, true],
    ]);
    expect(fs.readdirSync(path.join(root, "web")).sort()).toEqual([
      "package.json",
      "src",
    ]);
    expect(fs.readdirSync(path.join(root, "api")).sort()).toEqual([
      "app.py",
      "requirements.txt",
    ]);
    expect(
      info.mock.calls.map(([, data]) => [
        data.project,
        data.folder,
        data.bytes > 0,
      ]),
    ).toEqual([
      ["web", "node_modules", true],
      ["api", ".venv", true],
    ]);
  });

  it("skips a requested folder that is not eligible, even when the client asks for it", async () => {
    project("p", {
      "package.json": "{}",
      "node_modules/a.js": "1",
      "venv/lib/blob": "1",
      ".venv/pyvenv.cfg": "x",
    });
    const res = await clean(appWith(), {
      items: [{ project: "p", folders: ["venv", ".venv", "node_modules"] }],
    });
    expect(
      res.body.results.map(
        (r: { folder: string; state: string; reason?: string }) => [
          r.folder,
          r.state,
          r.reason,
        ],
      ),
    ).toEqual([
      ["venv", "skipped", "not_eligible"],
      [".venv", "skipped", "not_eligible"],
      ["node_modules", "removed", undefined],
    ]);
    expect([
      exists("p", "venv", "lib", "blob"),
      exists("p", ".venv", "pyvenv.cfg"),
    ]).toEqual([true, true]);
  });

  it("decides again at delete time: a folder whose precondition went away since the preview is kept", async () => {
    project("p", node());
    const app = appWith();
    expect((await preview(app)).body.projects).toHaveLength(1);
    fs.rmSync(path.join(root, "p", "package.json"));
    const res = await clean(app, {
      items: [{ project: "p", folders: ["node_modules"] }],
    });
    expect([
      res.body.results[0].state,
      res.body.results[0].reason,
      res.body.freedBytes,
    ]).toEqual(["skipped", "not_eligible", 0]);
    expect(exists("p", "node_modules", "dep", "index.js")).toBe(true);
  });

  it.each([
    [
      "its precondition is removed",
      (dir: string) => fs.rmSync(path.join(dir, "package.json")),
    ],
    [
      "it is swapped for a symlink",
      (dir: string) => {
        fs.renameSync(path.join(dir, "node_modules"), path.join(dir, "moved"));
        fs.symlinkSync(path.join(dir, "moved"), path.join(dir, "node_modules"));
      },
    ],
  ])(
    "keeps a folder when %s while it is being measured",
    async (_case, change) => {
      const dir = project("p", node());
      const real = systemDiskSys("linux");
      const disk = new DiskUsage(root, {
        sys: {
          ...real,
          du: async (d, ms) => {
            change(dir);
            return real.du(d, ms);
          },
        },
      });
      const res = await clean(appWith({ disk }), {
        items: [{ project: "p", folders: ["node_modules"] }],
      });
      expect([res.body.results[0].state, res.body.results[0].reason]).toEqual([
        "skipped",
        "not_eligible",
      ]);
      expect(
        fs.readdirSync(
          path.join(
            dir,
            fs.existsSync(path.join(dir, "moved")) ? "moved" : "node_modules",
          ),
        ),
      ).toEqual(["dep"]);
    },
  );

  it("does not remove a symlinked node_modules or anything it points to", async () => {
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep"), "1");
    project("p", { "package.json": "{}" });
    fs.symlinkSync(outside, path.join(root, "p", "node_modules"));
    const res = await clean(appWith(), {
      items: [{ project: "p", folders: ["node_modules"] }],
    });
    expect([res.body.results[0].state, res.body.results[0].reason]).toEqual([
      "skipped",
      "not_eligible",
    ]);
    expect([
      fs.lstatSync(path.join(root, "p", "node_modules")).isSymbolicLink(),
      fs.existsSync(path.join(outside, "keep")),
    ]).toEqual([true, true]);
  });

  it("skips projects that are running, have a chat turn, or are being deleted, and removes nothing there", async () => {
    project("busy", node());
    project("deleting", node());
    const starting = project("starting", node());
    const starts = new StartGuard();
    let releaseStart!: () => void;
    const booting = starts.run(
      starting,
      () => new Promise<void>((r) => (releaseStart = r)),
    );
    const release = markProjectDeleting(path.join(root, "deleting"))!;
    try {
      const res = await clean(
        appWith({ starts, chatTurnActive: (n) => n === "busy" }),
        {
          items: ["busy", "deleting", "starting"].map((project) => ({
            project,
            folders: ["node_modules"],
          })),
        },
      );
      expect(
        res.body.results.map(
          (r: { project: string; state: string; reason: string }) => [
            r.project,
            r.state,
            r.reason,
          ],
        ),
      ).toEqual([
        ["busy", "skipped", "chat_active"],
        ["deleting", "skipped", "deleting"],
        ["starting", "skipped", "running"],
      ]);
      expect(
        ["busy", "deleting", "starting"].every((p) =>
          exists(p, "node_modules", "dep", "index.js"),
        ),
      ).toBe(true);
    } finally {
      release();
      releaseStart();
      await booting;
    }
  });

  it("skips a project whose chat turn began while its folder was being measured", async () => {
    project("p", node());
    let calls = 0;
    const res = await clean(appWith({ chatTurnActive: () => calls++ > 0 }), {
      items: [{ project: "p", folders: ["node_modules"] }],
    });
    expect([res.body.results[0].state, res.body.results[0].reason]).toEqual([
      "skipped",
      "chat_active",
    ]);
    expect(exists("p", "node_modules", "dep", "index.js")).toBe(true);
  });

  it("reports a project that does not exist, or is a symlink alias, as not_found", async () => {
    project("real", node());
    fs.symlinkSync(path.join(root, "real"), path.join(root, "alias"));
    const res = await clean(appWith(), {
      items: [
        { project: "ghost", folders: ["node_modules"] },
        { project: "alias", folders: ["node_modules"] },
      ],
    });
    expect(res.body.results.map((r: { reason: string }) => r.reason)).toEqual([
      "not_found",
      "not_found",
    ]);
    expect(exists("real", "node_modules", "dep", "index.js")).toBe(true);
  });

  it("leaves the renamed folder when rm fails, reports failed, and the next cleanup sweeps it", async () => {
    project("p", node());
    const realRm = fs.promises.rm.bind(fs.promises);
    const rm = jest
      .spyOn(fs.promises, "rm")
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      });
    const app = appWith();
    const first = await clean(app, {
      items: [{ project: "p", folders: ["node_modules"] }],
    });
    expect([
      first.body.results[0].state,
      first.body.results[0].reason,
      first.body.freedBytes,
    ]).toEqual(["failed", "remove_failed", 0]);
    const left = fs
      .readdirSync(path.join(root, "p"))
      .filter((n) => n.startsWith(".pod-cleanup-"));
    expect([left.length, exists("p", "node_modules")]).toEqual([1, false]);
    rm.mockImplementation(realRm);

    fs.mkdirSync(path.join(root, "p", "node_modules"));
    const second = await clean(app, {
      items: [{ project: "p", folders: ["node_modules"] }],
    });
    expect(second.body.results[0].state).toBe("removed");
    expect(fs.readdirSync(path.join(root, "p")).sort()).toEqual([
      "package.json",
      "src",
    ]);
  });

  it("sweeps .pod-cleanup- folders but not a .pod-cleanup- symlink or what it points to", async () => {
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep"), "1");
    project("p", node({ ".pod-cleanup-old/x": "1" }));
    fs.symlinkSync(outside, path.join(root, "p", ".pod-cleanup-link"));
    await clean(appWith(), {
      items: [{ project: "p", folders: ["node_modules"] }],
    });
    expect(fs.readdirSync(path.join(root, "p")).sort()).toEqual([
      ".pod-cleanup-link",
      "package.json",
      "src",
    ]);
    expect(fs.existsSync(path.join(outside, "keep"))).toBe(true);
  });

  it("answers 409 cleanup_in_progress to a second cleanup while one runs", async () => {
    project("a", node());
    project("b", node());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atRename = new Promise<void>((r) => (reached = r));
    const realRename = fs.promises.rename.bind(fs.promises);
    jest.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      reached();
      await gate;
      return realRename(from, to);
    });
    const app = appWith();
    const first = Promise.resolve(
      clean(app, { items: [{ project: "a", folders: ["node_modules"] }] }),
    );
    await atRename;
    const second = await clean(app, {
      items: [{ project: "b", folders: ["node_modules"] }],
    });
    release();
    expect([second.status, second.body.code]).toEqual([
      409,
      "cleanup_in_progress",
    ]);
    expect((await first).body.results[0].state).toBe("removed");
    expect(exists("b", "node_modules", "dep", "index.js")).toBe(true);
  });

  it("invalidates the disk cache so the next disk read measures again", async () => {
    project("web", node());
    const app = appWith();
    const before = await request(app).get("/api/v1/projects/disk").set(ADMIN);
    expect(
      (await request(app).get("/api/v1/projects/disk").set(ADMIN)).body.cached,
    ).toBe(true);
    await clean(app, {
      items: [{ project: "web", folders: ["node_modules"] }],
    });
    const after = await request(app).get("/api/v1/projects/disk").set(ADMIN);
    expect(after.body.cached).toBe(false);
    expect(after.body.projects[0].bytes).toBeLessThan(
      before.body.projects[0].bytes,
    );
  });

  it("skips everything as unsupported on win32", async () => {
    project("web", node());
    const disk = new DiskUsage(root, { sys: systemDiskSys("win32") });
    const res = await clean(appWith({ disk }), {
      items: [{ project: "web", folders: ["node_modules"] }],
    });
    expect([res.body.results[0].state, res.body.results[0].reason]).toEqual([
      "skipped",
      "unsupported",
    ]);
    expect(exists("web", "node_modules", "dep", "index.js")).toBe(true);
  });

  it("merges a project named twice and removes each folder once", async () => {
    project("p", node());
    const res = await clean(appWith(), {
      items: [
        { project: "p", folders: ["node_modules", "node_modules"] },
        { project: "p", folders: ["node_modules"] },
      ],
    });
    expect(res.body.results.map((r: { state: string }) => r.state)).toEqual([
      "removed",
    ]);
  });

  it.each([
    ["no body", undefined],
    ["no items", {}],
    ["empty items", { items: [] }],
    [
      "201 items",
      {
        items: Array.from({ length: 201 }, (_, i) => ({
          project: `p${i}`,
          folders: ["node_modules"],
        })),
      },
    ],
    [
      "a body over 64 KiB",
      {
        items: [{ project: "p", folders: ["node_modules"] }],
        pad: "x".repeat(64 * 1024),
      },
    ],
    [
      "a project name with a slash",
      { items: [{ project: "../p", folders: ["node_modules"] }] },
    ],
    [
      "a hidden project name",
      { items: [{ project: ".p", folders: ["node_modules"] }] },
    ],
    [
      "folders that is not an array",
      { items: [{ project: "p", folders: "node_modules" }] },
    ],
    ["no folders", { items: [{ project: "p", folders: [] }] }],
    [
      "a folder outside the three names",
      { items: [{ project: "p", folders: ["dist"] }] },
    ],
    [
      "a folder path",
      { items: [{ project: "p", folders: ["../node_modules"] }] },
    ],
    [
      "a folder that is not a string",
      { items: [{ project: "p", folders: [1] }] },
    ],
    [
      "an inherited key",
      { items: [{ project: "p", folders: ["constructor"] }] },
    ],
  ])("answers 400 to %s and removes nothing", async (_case, body) => {
    project("p", node());
    const res = await clean(appWith(), body);
    expect([res.status, typeof res.body.error]).toEqual([400, "string"]);
    expect(exists("p", "node_modules", "dep", "index.js")).toBe(true);
  });
});

describe("cleanup routes", () => {
  it.each(["get", "post"] as const)(
    "refuse a key that is not an admin key on %s with 403 forbidden_key",
    async (method) => {
      project("p", node());
      const res = await request(appWith())
        [method]("/api/v1/projects/cleanup")
        .set({ Authorization: "Bearer k-write" })
        .send({ items: [{ project: "p", folders: ["node_modules"] }] });
      expect([res.status, res.body.code]).toEqual([403, "forbidden_key"]);
      expect(exists("p", "node_modules", "dep", "index.js")).toBe(true);
    },
  );

  it("are not taken for a project named cleanup: its /:name routes still answer", async () => {
    project("cleanup", node());
    const app = appWith();
    const running = await request(app)
      .get("/api/v1/projects/cleanup/running")
      .set(ADMIN);
    expect([running.status, Array.isArray(running.body.processes)]).toEqual([
      200,
      true,
    ]);
    expect((await preview(app)).body.projects[0].name).toBe("cleanup");
  });
});
