import express from "express";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import request from "supertest";
import { createProjectsRouter } from "../../src/api/projects-router";
import { resolveProjectsRoot } from "../../src/projects/chat";
import type { ApiKey, GatewayConfig } from "../../src/types";

const apiKeys: ApiKey[] = [
  { key: "k-admin", agents: ["alfred"], admin: true },
  { key: "k-pod-write", agents: "*", write: true, admin: true },
  { key: "k-pod-read", agents: "*" },
  { key: "k-agent", agents: ["alfred"], write: true },
  { key: "k-star-list", agents: ["*"], write: true },
];
const as = (key: string) => ({ Authorization: `Bearer ${key}` });
const POD = as("k-pod-write");

let base: string;
let root: string;
let app: express.Express;

beforeEach(() => {
  base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "projects-router-")),
  );
  root = path.join(base, "projects");
  app = express();
  app.use(express.json());
  app.use("/api", createProjectsRouter(apiKeys, root));
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

function seed(): void {
  fs.mkdirSync(path.join(root, "app", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "README.md"), "# hi\n");
}

describe("auth", () => {
  const routes: Array<
    [string, (a: request.Agent | ReturnType<typeof request>) => request.Test]
  > = [
    ["GET /projects", (r) => r.get("/api/v1/projects")],
    ["POST /projects", (r) => r.post("/api/v1/projects").send({ name: "x" })],
    ["GET git", (r) => r.get("/api/v1/projects/app/git")],
    ["GET running", (r) => r.get("/api/v1/projects/app/running")],
  ];

  it.each(["k-agent", "k-star-list", "k-pod-read"])(
    "%s may read projects but not create one",
    async (key) => {
      seed();
      expect((await request(app).get("/api/v1/projects").set(as(key))).status).toBe(200);
      expect((await request(app).get("/api/v1/projects/app/running").set(as(key))).status).toBe(200);
      const res = await request(app).post("/api/v1/projects").set(as(key)).send({ name: "x" });
      expect([res.status, res.body.code]).toEqual([403, "forbidden_key"]);
      expect(fs.existsSync(path.join(root, "x"))).toBe(false);
    },
  );

  it.each(routes)("%s requires a key", async (_label, call) => {
    expect((await call(request(app))).status).toBe(401);
  });

  it("an admin key may create", async () => {
    const res = await request(app)
      .post("/api/v1/projects")
      .set(as("k-admin"))
      .send({ name: "new" });
    expect(res.status).toBe(201);
  });
});

describe("GET /api/v1/projects", () => {
  it("reports a missing root without creating it", async () => {
    const res = await request(app).get("/api/v1/projects").set(POD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ root, exists: false, projects: [] });
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe("a root that is a regular file", () => {
  it.each([
    ["GET /projects", () => request(app).get("/api/v1/projects")],
    [
      "POST /projects",
      () => request(app).post("/api/v1/projects").send({ name: "x" }),
    ],
    ["GET running", () => request(app).get("/api/v1/projects/x/running")],
  ])("%s returns 400 not_a_directory", async (_label, call) => {
    fs.writeFileSync(root, "not a dir");
    const res = await call().set(POD);
    expect([res.status, res.body.code]).toEqual([400, "not_a_directory"]);
    expect(fs.readFileSync(root, "utf8")).toBe("not a dir");
  });
});

describe("POST /api/v1/projects", () => {
  it("creates, then 409s a duplicate while keeping the first project intact", async () => {
    const first = await request(app)
      .post("/api/v1/projects")
      .set(POD)
      .send({ name: "app" });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      project: {
        name: "app",
        path: path.join(root, "app"),
        modified_at: expect.any(String),
        is_git: false,
        stack: null,
      },
    });
    fs.writeFileSync(path.join(root, "app", "work.txt"), "unsaved work");

    const second = await request(app)
      .post("/api/v1/projects")
      .set(POD)
      .send({ name: "app", git_init: true });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: expect.any(String),
      code: "project_exists",
    });
    expect(fs.readFileSync(path.join(root, "app", "work.txt"), "utf8")).toBe(
      "unsaved work",
    );
    expect(fs.existsSync(path.join(root, "app", ".git"))).toBe(false);
  });

  it("answers 409 project_exists for a case-only collision", async () => {
    await request(app).post("/api/v1/projects").set(POD).send({ name: "Site" });
    const res = await request(app)
      .post("/api/v1/projects")
      .set(POD)
      .send({ name: "site" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("project_exists");
    expect(fs.readdirSync(root)).toEqual(["Site"]);
  });

  it("git_init creates a repository", async () => {
    const res = await request(app)
      .post("/api/v1/projects")
      .set(POD)
      .send({ name: "repo", git_init: true });
    expect(res.status).toBe(201);
    expect(res.body.project.is_git).toBe(true);
    expect(res.body.warning).toBeUndefined();
    expect(fs.existsSync(path.join(root, "repo", ".git", "HEAD"))).toBe(true);
  });

  it.each(["../x", "a/b", ".", "..", ".git", ".hidden", "a".repeat(65), "", undefined])(
    "rejects name %p with 400 invalid_name",
    async (name) => {
      const res = await request(app)
        .post("/api/v1/projects")
        .set(POD)
        .send({ name });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_name");
      expect(fs.existsSync(path.join(base, "x"))).toBe(false);
    },
  );
});

describe("project files", () => {
  it.each(apiKeys.map((k) => k.key))(
    "%s gets 404 from the removed tree and file routes, and no file content",
    async (key) => {
      seed();
      for (const url of [
        "/api/v1/projects/app/tree",
        "/api/v1/projects/app/tree?path=src",
        "/api/v1/projects/app/file?path=README.md",
      ]) {
        const res = await request(app).get(url).set(as(key));
        expect([url, res.status]).toEqual([url, 404]);
        expect(res.text).not.toContain("# hi");
      }
    },
  );
});

describe("GET /api/v1/projects/:name routes", () => {
  it("rejects an encoded traversal in the project name", async () => {
    const res = await request(app)
      .get("/api/v1/projects/..%2F..%2Fetc/git")
      .set(POD);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_name");
  });

  it("refuses a project directory that is itself a symlink out of the root", async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync("/etc", path.join(root, "etc"));
    const res = await request(app)
      .get("/api/v1/projects/etc/running")
      .set(POD);
    expect([res.status, res.body.code]).toEqual([403, "path_escape"]);
    const list = await request(app).get("/api/v1/projects").set(POD);
    expect(list.body.projects).toEqual([]);
  });

  it("answers 404 not_found for a missing project", async () => {
    seed();
    const res = await request(app).get("/api/v1/projects/ghost/running").set(POD);
    expect([res.status, res.body.code]).toEqual([404, "not_found"]);
  });
});

describe("resolveProjectsRoot", () => {
  const config = (projects?: { root?: string }) =>
    ({ gateway: { projects }, agents: [] }) as unknown as GatewayConfig;

  it("uses the configured root, expanding ~/", () => {
    expect(resolveProjectsRoot(config({ root: "/srv/projects" }))).toBe(
      "/srv/projects",
    );
    expect(resolveProjectsRoot(config({ root: "~/code" }))).toBe(
      path.join(os.homedir(), "code"),
    );
  });

  it("falls back to ~/projects when unset", () => {
    expect(resolveProjectsRoot(config())).toBe(
      path.join(os.homedir(), "projects"),
    );
    expect(resolveProjectsRoot(config({}))).toBe(
      path.join(os.homedir(), "projects"),
    );
  });
});
