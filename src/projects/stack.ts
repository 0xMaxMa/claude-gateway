import { promises as fsp } from "fs";
import * as path from "path";

export const STACKS = [
  "nextjs",
  "astro",
  "react",
  "vue",
  "svelte",
  "node",
  "python",
  "go",
  "rust",
  "ruby",
  "php",
  "java",
  "html",
] as const;

export type Stack = (typeof STACKS)[number];

const PACKAGE_JSON_LIMIT = 256 * 1024;

/** First match wins, so a framework is named before the runtime under it. */
const NODE_FRAMEWORKS: ReadonlyArray<readonly [dep: string, stack: Stack]> = [
  ["next", "nextjs"],
  ["astro", "astro"],
  ["react", "react"],
  ["vue", "vue"],
  ["svelte", "svelte"],
];

const ROOT_MARKERS: ReadonlyArray<
  readonly [files: readonly string[], stack: Stack]
> = [
  [
    ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", "manage.py"],
    "python",
  ],
  [["go.mod"], "go"],
  [["Cargo.toml"], "rust"],
  [["Gemfile"], "ruby"],
  [["composer.json"], "php"],
  [["pom.xml", "build.gradle", "build.gradle.kts"], "java"],
];

export function stackFromPackageJson(raw: string): Stack {
  try {
    const pkg = JSON.parse(raw) as {
      dependencies?: object;
      devDependencies?: object;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [dep, stack] of NODE_FRAMEWORKS) if (dep in deps) return stack;
  } catch {
    // A package.json that does not parse still marks a Node project.
  }
  return "node";
}

/** Null when the folder shows no marker: the client keeps its generic folder icon. */
export function detectStack(
  rootNames: ReadonlySet<string>,
  packageJson: string | null,
): Stack | null {
  if (packageJson !== null) return stackFromPackageJson(packageJson);
  for (const [files, stack] of ROOT_MARKERS)
    if (files.some((f) => rootNames.has(f))) return stack;
  return rootNames.has("index.html") ? "html" : null;
}

export async function readStack(dir: string): Promise<Stack | null> {
  const names = await fsp.readdir(dir).catch(() => null);
  if (!names) return null;
  const rootNames = new Set(names);
  let packageJson: string | null = null;
  if (rootNames.has("package.json")) {
    const file = path.join(dir, "package.json");
    const st = await fsp.stat(file).catch(() => null);
    if (st?.isFile() && st.size <= PACKAGE_JSON_LIMIT) {
      packageJson = await fsp.readFile(file, "utf8").catch(() => "");
    } else {
      packageJson = "";
    }
  }
  return detectStack(rootNames, packageJson);
}
