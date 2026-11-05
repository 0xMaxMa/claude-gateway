import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { folderSize, listDir, makeDir, parseDuTotal, resolveDir } from "../../src/files/fs";
import { RelPath } from "../../src/files/paths";
import { silentLogger } from "../helpers/silent-logger";

const rel = (s: string) => s as RelPath;

let base: string;
let root: string;

beforeEach(() => {
  base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "files-fs-")),
  );
  root = path.join(base, "projects");
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

function makeDirs(
  n: string,
  files: Record<string, string | Buffer> = {},
): string {
  const dir = path.join(root, n);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  return dir;
}

describe("listDir", () => {
  it("reports statfs capacity only on the real root listing", async () => {
    makeDirs("alpha");
    const link = path.join(base, "projects-link");
    fs.symlinkSync(root, link);
    const rootResult = await listDir(link, rel(""));
    if (!rootResult.ok) throw new Error(rootResult.error);
    const st = await fs.promises.statfs(root, { bigint: true });
    expect(rootResult.value.filesystem).toEqual({
      total: Number(st.blocks * BigInt(st.bsize)),
      free: Number(st.bfree * BigInt(st.bsize)),
      available: Number(st.bavail * BigInt(st.bsize)),
    });
    const nested = await listDir(link, rel("alpha"));
    if (!nested.ok) throw new Error(nested.error);
    expect(nested.value.filesystem).toBeUndefined();
  });

  it("omits filesystem capacity if statfs fails", async () => {
    makeDirs("alpha");
    jest.spyOn(fs.promises, "statfs").mockRejectedValueOnce(Object.assign(new Error("unavailable"), { code: "ENOSYS" }));
    const result = await listDir(root, rel(""));
    if (!result.ok) throw new Error(result.error);
    expect(result.value.filesystem).toBeUndefined();
    expect(result.value.entries).toHaveLength(1);
  });
  it("reports a missing root as exists:false without creating it", async () => {
    expect(await listDir(root, rel(""))).toEqual({
      ok: true,
      value: { root, exists: false, path: "", abs: root, entries: [] },
    });
    expect(fs.existsSync(root)).toBe(false);
  });

  it("lists directories and in-root dir symlinks sorted by name, skipping files and escaping links", async () => {
    makeDirs("zeta");
    makeDirs("alpha", { ".git/HEAD": "ref: refs/heads/main\n" });
    fs.writeFileSync(path.join(root, "notes.txt"), "x");
    fs.symlinkSync(path.join(root, "zeta"), path.join(root, "link-in"));
    const outside = fs.mkdtempSync(path.join(base, "outside-"));
    fs.symlinkSync(outside, path.join(root, "link-out"));

    const res = await listDir(root, rel(""));
    if (!res.ok) throw new Error(res.error);
    expect(res.value.exists).toBe(true);
    expect(res.value.entries.map((p) => [p.name, p.is_git, p.abs])).toEqual([
      ["alpha", true, path.join(root, "alpha")],
      ["link-in", false, path.join(root, "link-in")],
      ["zeta", false, path.join(root, "zeta")],
    ]);
    expect(Number.isNaN(Date.parse(res.value.entries[0].modified_at))).toBe(
      false,
    );
  });

  it("reports the resolved root when the configured root is a symlink", async () => {
    makeDirs("alpha");
    const link = path.join(base, "projects-link");
    fs.symlinkSync(root, link);

    const res = await listDir(link, rel(""));
    if (!res.ok) throw new Error(res.error);
    expect(res.value.root).toBe(root);
    expect(res.value.entries.map((p) => p.abs)).toEqual([
      path.join(root, "alpha"),
    ]);
  });
});

describe("folderSize", () => {
  it("shares one measurement between callers that ask at the same time", async () => {
    const dir = makeDirs("app", { "a.txt": "x".repeat(4096) });
    const first = folderSize(dir);
    expect(folderSize(dir)).toBe(first);
    expect(await first).toEqual(expect.any(Number));
  });
});

describe("makeDir", () => {
  it("creates the root on demand and refuses a second create without touching the first", async () => {
    const first = await makeDir(root, rel("app"), false, silentLogger);
    if (!first.ok) throw new Error(first.error);
    expect(first.value).toEqual({
      entry: {
        name: "app",
        path: "app",
        abs: path.join(root, "app"),
        type: "dir",
        modified_at: expect.any(String),
        is_git: false,
        size: expect.any(Number),
      },
    });
    fs.writeFileSync(path.join(root, "app", "keep.txt"), "precious");

    expect(await makeDir(root, rel("app"), false, silentLogger)).toEqual({
      ok: false,
      error: "already_exists",
    });
    expect(fs.readFileSync(path.join(root, "app", "keep.txt"), "utf8")).toBe(
      "precious",
    );
  });

  it("treats a name differing only in case as existing and leaves the first untouched", async () => {
    const first = await makeDir(root, rel("Site"), false, silentLogger);
    if (!first.ok) throw new Error(first.error);
    expect(await makeDir(root, rel("site"), false, silentLogger)).toEqual({
      ok: false,
      error: "already_exists",
    });
    expect(fs.readdirSync(root)).toEqual(["Site"]);
  });

  it("refuses a name held by a file, a symlink, or a dangling symlink", async () => {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "afile"), "x");
    fs.symlinkSync(base, path.join(root, "alink"));
    fs.symlinkSync(path.join(base, "nowhere"), path.join(root, "dangling"));
    for (const n of ["afile", "alink", "dangling", "AFILE"]) {
      expect(await makeDir(root, rel(n), true, silentLogger)).toEqual({
        ok: false,
        error: "already_exists",
      });
    }
    expect(fs.readFileSync(path.join(root, "afile"), "utf8")).toBe("x");
    expect(fs.lstatSync(path.join(root, "alink")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(base, ".git"))).toBe(false);
  });

  it("lets exactly one of many concurrent creates of the same name win", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => makeDir(root, rel("race"), false, silentLogger)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) {
      expect(r).toEqual({ ok: false, error: "already_exists" });
    }
  });

  it("lets exactly one of concurrent creates differing only in case win", async () => {
    for (let trial = 0; trial < 100; trial++) {
      const trialRoot = path.join(base, `case-race-${trial}`);
      fs.mkdirSync(trialRoot);
      fs.mkdirSync(path.join(trialRoot, "other"));
      const results = await Promise.all(
        ["Foo", "foo", "FOO", "fOo"].map((n) =>
          makeDir(trialRoot, rel(n), false, silentLogger),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results.filter((r) => !r.ok)) {
        expect(r).toEqual({ ok: false, error: "already_exists" });
      }
      expect(
        fs.readdirSync(trialRoot).filter((n) => n.toLowerCase() === "foo"),
      ).toHaveLength(1);
    }
  });

  it("reports the same real path that listDir does when the configured root is a symlink", async () => {
    fs.mkdirSync(root);
    const link = path.join(base, "projects-link");
    fs.symlinkSync(root, link);

    const created = await makeDir(link, rel("app"), false, silentLogger);
    if (!created.ok) throw new Error(created.error);
    expect(created.value.entry.abs).toBe(path.join(root, "app"));

    const listed = await listDir(link, rel(""));
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value.entries.map((p) => p.abs)).toEqual([
      created.value.entry.abs,
    ]);
  });

  it("runs git init when asked", async () => {
    const res = await makeDir(root, rel("repo"), true, silentLogger);
    if (!res.ok) throw new Error(res.error);
    expect(res.value.warning).toBeUndefined();
    expect(res.value.entry.is_git).toBe(true);
    expect(fs.statSync(path.join(root, "repo", ".git")).isDirectory()).toBe(
      true,
    );
  });

  it("creates the repository in the new folder even when GIT_* variables point elsewhere", async () => {
    const elsewhere = path.join(base, "elsewhere.git");
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    };
    process.env.GIT_DIR = elsewhere;
    process.env.GIT_WORK_TREE = base;
    try {
      const res = await makeDir(root, rel("g1"), true, silentLogger);
      if (!res.ok) throw new Error(res.error);
      expect(res.value.warning).toBeUndefined();
      expect(res.value.entry.is_git).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(fs.existsSync(path.join(root, "g1", ".git", "HEAD"))).toBe(true);
    expect(fs.existsSync(elsewhere)).toBe(false);
  });

  it("keeps the directory and returns a warning when git is not on PATH", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = fs.mkdtempSync(path.join(base, "empty-bin-"));
    try {
      const res = await makeDir(root, rel("nogit"), true, silentLogger);
      if (!res.ok) throw new Error(res.error);
      expect(res.value.warning).toBe("git init failed (ENOENT)");
      expect(res.value.entry.is_git).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(fs.statSync(path.join(root, "nogit")).isDirectory()).toBe(true);
  });

  it.each([
    ["exit 3", "git init failed (exit code 3)"],
    ["kill -TERM $$", "git init failed (signal SIGTERM)"],
  ])(
    "reports a failing git (%s) without echoing its stderr, which is only logged",
    async (ending, warning) => {
      const bin = fs.mkdtempSync(path.join(base, "fake-bin-"));
      fs.writeFileSync(
        path.join(bin, "git"),
        `#!/bin/sh\necho "SECRET-STDERR $HOME" >&2\n${ending}\n`,
        { mode: 0o755 },
      );
      const warn = jest.fn();
      const savedPath = process.env.PATH;
      process.env.PATH = `${bin}:${savedPath}`;
      try {
        const res = await makeDir(root, rel("broken"), true, { ...silentLogger, warn });
        if (!res.ok) throw new Error(res.error);
        expect(res.value.warning).toBe(warning);
      } finally {
        process.env.PATH = savedPath;
      }
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("SECRET-STDERR"),
      );
    },
  );
});

describe("resolveDir", () => {
  it("refuses a folder that is itself a symlink escaping the root", async () => {
    fs.mkdirSync(root, { recursive: true });
    const outside = fs.mkdtempSync(path.join(base, "outside-"));
    fs.symlinkSync(outside, path.join(root, "evil"));
    expect(await resolveDir(root, rel("evil"))).toEqual({
      ok: false,
      error: "path_escape",
    });
  });

  it("refuses a folder that is a symlink back to the root", async () => {
    makeDirs("app", { "a.txt": "a" });
    fs.symlinkSync(".", path.join(root, "all"));
    expect(await resolveDir(root, rel("all"))).toEqual({
      ok: false,
      error: "path_escape",
    });
    const listed = await listDir(root, rel(""));
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value.entries.map((p) => p.name)).toEqual(["app"]);
  });

  it("maps a file to not_a_directory and a missing folder to not_found", async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "plain"), "");
    expect(await resolveDir(root, rel("plain"))).toEqual({
      ok: false,
      error: "not_a_directory",
    });
    expect(await resolveDir(root, rel("ghost"))).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});

describe("nested paths", () => {
  it("lists a folder under the root with relative paths and real absolute ones", async () => {
    makeDirs("app", { "node_modules/x/index.js": "1", "src/a.ts": "a", "README.md": "r" });
    fs.symlinkSync(path.join(root, "app"), path.join(root, "alias"));
    const res = await listDir(root, rel("alias"));
    if (!res.ok) throw new Error(res.error);
    expect(res.value).toMatchObject({ root, exists: true, path: "alias", abs: path.join(root, "app") });
    expect(res.value.entries.map((e) => [e.name, e.path, e.abs])).toEqual([
      ["node_modules", "alias/node_modules", path.join(root, "app", "node_modules")],
      ["src", "alias/src", path.join(root, "app", "src")],
    ]);
  });

  it("answers not_found for a missing folder under an existing root, and never exists:false", async () => {
    makeDirs("app");
    expect(await listDir(root, rel("app/nope"))).toEqual({ ok: false, error: "not_found" });
    expect(await listDir(root, rel("nope"))).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses to list through a link out of the root", async () => {
    fs.mkdirSync(root);
    fs.symlinkSync(fs.mkdtempSync(path.join(base, "outside-")), path.join(root, "out"));
    expect(await listDir(root, rel("out"))).toEqual({ ok: false, error: "path_escape" });
  });

  it("creates exactly one new folder whose parent exists, and nothing above it", async () => {
    makeDirs("app");
    const made = await makeDir(root, rel("app/web"), false, silentLogger);
    if (!made.ok) throw new Error(made.error);
    expect(made.value.entry).toMatchObject({ name: "web", path: "app/web", abs: path.join(root, "app", "web") });
    expect(await makeDir(root, rel("app/a/b"), false, silentLogger)).toEqual({ ok: false, error: "not_found" });
    expect(fs.existsSync(path.join(root, "app", "a"))).toBe(false);
    expect(await makeDir(root, rel("ghost/web"), false, silentLogger)).toEqual({ ok: false, error: "not_found" });
    expect(fs.existsSync(path.join(root, "ghost"))).toBe(false);
  });

  it("refuses a case-only collision inside a nested folder", async () => {
    makeDirs("app", { "Web/x": "1" });
    expect(await makeDir(root, rel("app/web"), false, silentLogger)).toEqual({ ok: false, error: "already_exists" });
  });

  it("refuses a new folder under a link out of the root and creates nothing there", async () => {
    fs.mkdirSync(root);
    const outside = fs.mkdtempSync(path.join(base, "outside-"));
    fs.symlinkSync(outside, path.join(root, "out"));
    expect(await makeDir(root, rel("out/new"), false, silentLogger)).toEqual({ ok: false, error: "path_escape" });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses an empty path, which names the root", async () => {
    fs.mkdirSync(root);
    expect(await makeDir(root, rel(""), false, silentLogger)).toEqual({ ok: false, error: "invalid_path" });
  });
});

describe('folder size', () => {
  it('reports the bytes a folder occupies, and parses du output', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-size-'));
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app', 'big.bin'), Buffer.alloc(64 * 1024, 1));
    const listing = await listDir(root, rel(''));
    if (!listing.ok) throw new Error('list failed');
    const app = listing.value.entries.find((e) => e.name === 'app');
    expect(app?.size).toBeGreaterThanOrEqual(64 * 1024);
    expect(parseDuTotal('8192\t/x\n')).toBe(8192);
    expect(parseDuTotal('')).toBeNull();
  });
});
