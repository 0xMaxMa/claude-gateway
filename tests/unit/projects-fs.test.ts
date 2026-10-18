import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createProject,
  listProjects,
  resolveProjectDir,
} from "../../src/projects/fs";
import { ProjectName } from "../../src/projects/paths";

const name = (s: string) => s as ProjectName;

let base: string;
let root: string;

beforeEach(() => {
  base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "projects-fs-")),
  );
  root = path.join(base, "projects");
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

function makeProject(
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

describe("listProjects", () => {
  it("reports a missing root as exists:false without creating it", async () => {
    expect(await listProjects(root)).toEqual({
      ok: true,
      value: { root, exists: false, projects: [] },
    });
    expect(fs.existsSync(root)).toBe(false);
  });

  it("lists directories and in-root dir symlinks sorted by name, skipping files and escaping links", async () => {
    makeProject("zeta");
    makeProject("alpha", { ".git/HEAD": "ref: refs/heads/main\n" });
    fs.writeFileSync(path.join(root, "notes.txt"), "x");
    fs.symlinkSync(path.join(root, "zeta"), path.join(root, "link-in"));
    const outside = fs.mkdtempSync(path.join(base, "outside-"));
    fs.symlinkSync(outside, path.join(root, "link-out"));

    const res = await listProjects(root);
    if (!res.ok) throw new Error(res.error);
    expect(res.value.exists).toBe(true);
    expect(res.value.projects.map((p) => [p.name, p.is_git, p.path])).toEqual([
      ["alpha", true, path.join(root, "alpha")],
      ["link-in", false, path.join(root, "link-in")],
      ["zeta", false, path.join(root, "zeta")],
    ]);
    expect(Number.isNaN(Date.parse(res.value.projects[0].modified_at))).toBe(
      false,
    );
  });

  it("reports the resolved root when the configured root is a symlink", async () => {
    makeProject("alpha");
    const link = path.join(base, "projects-link");
    fs.symlinkSync(root, link);

    const res = await listProjects(link);
    if (!res.ok) throw new Error(res.error);
    expect(res.value.root).toBe(root);
    expect(res.value.projects.map((p) => p.path)).toEqual([
      path.join(root, "alpha"),
    ]);
  });
});

describe("createProject", () => {
  it("creates the root on demand and refuses a second create without touching the first", async () => {
    const first = await createProject(root, name("app"), false);
    if (!first.ok) throw new Error(first.error);
    expect(first.value).toEqual({
      project: {
        name: "app",
        path: path.join(root, "app"),
        modified_at: expect.any(String),
        is_git: false,
        stack: null,
      },
    });
    fs.writeFileSync(path.join(root, "app", "keep.txt"), "precious");

    expect(await createProject(root, name("app"), false)).toEqual({
      ok: false,
      error: "project_exists",
    });
    expect(fs.readFileSync(path.join(root, "app", "keep.txt"), "utf8")).toBe(
      "precious",
    );
  });

  it("treats a name differing only in case as existing and leaves the first untouched", async () => {
    const first = await createProject(root, name("Site"), false);
    if (!first.ok) throw new Error(first.error);
    expect(await createProject(root, name("site"), false)).toEqual({
      ok: false,
      error: "project_exists",
    });
    expect(fs.readdirSync(root)).toEqual(["Site"]);
  });

  it("refuses a name held by a file, a symlink, or a dangling symlink", async () => {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "afile"), "x");
    fs.symlinkSync(base, path.join(root, "alink"));
    fs.symlinkSync(path.join(base, "nowhere"), path.join(root, "dangling"));
    for (const n of ["afile", "alink", "dangling", "AFILE"]) {
      expect(await createProject(root, name(n), true)).toEqual({
        ok: false,
        error: "project_exists",
      });
    }
    expect(fs.readFileSync(path.join(root, "afile"), "utf8")).toBe("x");
    expect(fs.lstatSync(path.join(root, "alink")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(base, ".git"))).toBe(false);
  });

  it("lets exactly one of many concurrent creates of the same name win", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => createProject(root, name("race"), false)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) {
      expect(r).toEqual({ ok: false, error: "project_exists" });
    }
  });

  it("lets exactly one of concurrent creates differing only in case win", async () => {
    for (let trial = 0; trial < 100; trial++) {
      const trialRoot = path.join(base, `case-race-${trial}`);
      fs.mkdirSync(trialRoot);
      fs.mkdirSync(path.join(trialRoot, "other"));
      const results = await Promise.all(
        ["Foo", "foo", "FOO", "fOo"].map((n) =>
          createProject(trialRoot, name(n), false),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results.filter((r) => !r.ok)) {
        expect(r).toEqual({ ok: false, error: "project_exists" });
      }
      expect(
        fs.readdirSync(trialRoot).filter((n) => n.toLowerCase() === "foo"),
      ).toHaveLength(1);
    }
  });

  it("reports the same real path that listProjects does when the configured root is a symlink", async () => {
    fs.mkdirSync(root);
    const link = path.join(base, "projects-link");
    fs.symlinkSync(root, link);

    const created = await createProject(link, name("app"), false);
    if (!created.ok) throw new Error(created.error);
    expect(created.value.project.path).toBe(path.join(root, "app"));

    const listed = await listProjects(link);
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value.projects.map((p) => p.path)).toEqual([
      created.value.project.path,
    ]);
  });

  it("runs git init when asked", async () => {
    const res = await createProject(root, name("repo"), true);
    if (!res.ok) throw new Error(res.error);
    expect(res.value.warning).toBeUndefined();
    expect(res.value.project.is_git).toBe(true);
    expect(fs.statSync(path.join(root, "repo", ".git")).isDirectory()).toBe(
      true,
    );
  });

  it("creates the repository in the project even when GIT_* variables point elsewhere", async () => {
    const elsewhere = path.join(base, "elsewhere.git");
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    };
    process.env.GIT_DIR = elsewhere;
    process.env.GIT_WORK_TREE = base;
    try {
      const res = await createProject(root, name("g1"), true);
      if (!res.ok) throw new Error(res.error);
      expect(res.value.warning).toBeUndefined();
      expect(res.value.project.is_git).toBe(true);
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
      const res = await createProject(root, name("nogit"), true);
      if (!res.ok) throw new Error(res.error);
      expect(res.value.warning).toBe("git init failed (ENOENT)");
      expect(res.value.project.is_git).toBe(false);
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
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const savedPath = process.env.PATH;
      process.env.PATH = `${bin}:${savedPath}`;
      try {
        const res = await createProject(root, name("broken"), true);
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

describe("resolveProjectDir", () => {
  it("refuses a project dir that is itself a symlink escaping the root", async () => {
    fs.mkdirSync(root, { recursive: true });
    const outside = fs.mkdtempSync(path.join(base, "outside-"));
    fs.symlinkSync(outside, path.join(root, "evil"));
    expect(await resolveProjectDir(root, name("evil"))).toEqual({
      ok: false,
      error: "path_escape",
    });
  });

  it("refuses a project that is a symlink back to the projects root", async () => {
    makeProject("app", { "a.txt": "a" });
    fs.symlinkSync(".", path.join(root, "all"));
    expect(await resolveProjectDir(root, name("all"))).toEqual({
      ok: false,
      error: "path_escape",
    });
    const listed = await listProjects(root);
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value.projects.map((p) => p.name)).toEqual(["app"]);
  });

  it("maps a file to not_a_directory and a missing project to not_found", async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "plain"), "");
    expect(await resolveProjectDir(root, name("plain"))).toEqual({
      ok: false,
      error: "not_a_directory",
    });
    expect(await resolveProjectDir(root, name("ghost"))).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});
