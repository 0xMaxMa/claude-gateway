import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import {
  detectStack,
  readStack,
  stackFromPackageJson,
} from "../../src/projects/stack";

const names = (...n: string[]) => new Set(n);

describe("stackFromPackageJson", () => {
  it("names the framework before the runtime under it", () => {
    expect(
      stackFromPackageJson('{"dependencies":{"next":"1","react":"1"}}'),
    ).toBe("nextjs");
    expect(stackFromPackageJson('{"devDependencies":{"astro":"1"}}')).toBe(
      "astro",
    );
    expect(
      stackFromPackageJson('{"dependencies":{"react":"1","vite":"1"}}'),
    ).toBe("react");
    expect(stackFromPackageJson('{"dependencies":{"vue":"1"}}')).toBe("vue");
    expect(stackFromPackageJson('{"devDependencies":{"svelte":"1"}}')).toBe(
      "svelte",
    );
  });

  it("falls back to node for a plain or unreadable package.json", () => {
    expect(stackFromPackageJson('{"dependencies":{"express":"1"}}')).toBe(
      "node",
    );
    expect(stackFromPackageJson("{}")).toBe("node");
    expect(stackFromPackageJson("not json")).toBe("node");
    expect(stackFromPackageJson("null")).toBe("node");
  });
});

describe("detectStack", () => {
  it("reads root files for non-Node stacks", () => {
    expect(detectStack(names("pyproject.toml"), null)).toBe("python");
    expect(detectStack(names("manage.py"), null)).toBe("python");
    expect(detectStack(names("go.mod"), null)).toBe("go");
    expect(detectStack(names("Cargo.toml"), null)).toBe("rust");
    expect(detectStack(names("Gemfile"), null)).toBe("ruby");
    expect(detectStack(names("composer.json"), null)).toBe("php");
    expect(detectStack(names("pom.xml"), null)).toBe("java");
  });

  it("calls a lone index.html html and anything else unknown", () => {
    expect(detectStack(names("index.html"), null)).toBe("html");
    expect(detectStack(names("notes.md"), null)).toBeNull();
    expect(detectStack(names(), null)).toBeNull();
  });

  it("prefers package.json over python or html files beside it", () => {
    expect(
      detectStack(
        names("requirements.txt", "index.html"),
        '{"dependencies":{"vue":"1"}}',
      ),
    ).toBe("vue");
  });
});

describe("readStack", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "stack-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the project folder", () => {
    writeFileSync(
      path.join(dir, "package.json"),
      '{"dependencies":{"react":"1"}}',
    );
    return expect(readStack(dir)).resolves.toBe("react");
  });

  it("treats an oversized package.json as plain node and a missing folder as unknown", async () => {
    writeFileSync(path.join(dir, "package.json"), "x".repeat(300 * 1024));
    await expect(readStack(dir)).resolves.toBe("node");
    await expect(readStack(path.join(dir, "gone"))).resolves.toBeNull();
  });

  it("ignores a package.json that is a directory", async () => {
    mkdirSync(path.join(dir, "package.json"));
    await expect(readStack(dir)).resolves.toBe("node");
  });
});
