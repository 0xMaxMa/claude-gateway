import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

// ─── app.yaml types ───────────────────────────────────────────────────────────

export interface AppYamlPort {
  name: string;
  container: number;
  type?: 'api' | 'web';
  rate_limit?: number;
}

export interface AppYamlScriptArg {
  name: string;
  type: string;
  pattern?: string;
}

export interface AppYamlScript {
  path: string;
  timeout?: string;
  args?: AppYamlScriptArg[];
}

export interface AppYamlGatewayApi {
  socket: string;
  scripts?: Record<string, AppYamlScript>;
}

export interface AppYamlHealthcheck {
  test: string;
  interval?: string;
  timeout?: string;
  retries?: number;
}

export interface AppYamlService {
  build?: string;
  image?: string;
  command?: string | string[];
  entrypoint?: string | string[];
  working_dir?: string;
  user?: string;
  environment?: string[];
  volumes?: string[];
  ports?: AppYamlPort[];
  depends_on?: string[];
  healthcheck?: AppYamlHealthcheck;
  gateway_api?: AppYamlGatewayApi;
}

export interface AppYamlAgentService {
  path: string;
  name: string;
}

export interface AppYaml {
  apiVersion: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  source?: string;
  commit: string;
  resources?: { cpu?: number; memory?: string };
  services: Record<string, AppYamlService | AppYamlAgentService>;
}

// ─── Result types ─────────────────────────────────────────────────────────────

export interface ComposePort {
  name: string;
  service: string;
  containerPort: number;
  type: 'api' | 'web';
  rateLimit: number;
}

export interface ScriptConfig {
  path: string;
  timeout: string;
  args?: Array<{ name: string; type: string; pattern?: string }>;
}

export interface ComposeSocket {
  service: string;
  hostSocketPath: string;
  scripts: Record<string, ScriptConfig>;
}

export interface AgentDeclaration {
  path: string;
  name: string;
}

export interface GeneratedCompose {
  ports: ComposePort[];
  sockets: ComposeSocket[];
  secretKeys: string[];
  agentDeclaration: AgentDeclaration | null;
  warnings: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BANNED_PORTS = new Set([22, 80, 443, 10850]);
const ALLOWED_SERVICE_FIELDS = new Set([
  'build', 'image', 'command', 'entrypoint', 'working_dir', 'user',
  'environment', 'volumes', 'ports', 'depends_on', 'healthcheck', 'gateway_api',
]);
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const IMAGE_RE = /^[a-z0-9._\-/:@]+$/;
const NAMED_VOLUME_RE = /^[a-z0-9_-]+$/;
const AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;
const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SOCKET_DIR = '/run/claude-gateway/apps';

const DEFAULT_CPU = 1.0;
const DEFAULT_MEMORY = '256M';
const MAX_CPU = 4.0;
const MAX_MEMORY_MB = 2048;

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse and validate app.yaml content.
 * appDir is used to resolve and range-check build/script paths.
 */
export function parseAppYaml(content: string, appDir: string): AppYaml {
  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (e) {
    throw new Error(`Failed to parse app.yaml: ${(e as Error).message}`);
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('app.yaml must be a YAML object');
  }
  const obj = raw as Record<string, unknown>;

  requireString(obj, 'apiVersion');
  requireString(obj, 'name');
  requireString(obj, 'version');
  requireString(obj, 'commit');

  if (typeof obj['services'] !== 'object' || obj['services'] === null) {
    throw new Error('app.yaml: "services" must be an object');
  }

  const services = obj['services'] as Record<string, unknown>;
  for (const [svcName, svcDef] of Object.entries(services)) {
    if (svcName === 'agent') {
      validateAgentServiceDecl(svcDef);
    } else {
      validateService(svcName, svcDef, appDir);
    }
  }

  if (obj['resources'] !== undefined) {
    validateResources(obj['resources']);
  }

  return raw as AppYaml;
}

// ─── Generation ───────────────────────────────────────────────────────────────

/**
 * Generate docker-compose.yml from a parsed app.yaml.
 * Writes the file to outputPath and returns metadata for the installer.
 */
export function generateCompose(
  appYaml: AppYaml,
  appName: string,
  appDir: string,
  outputPath: string,
): GeneratedCompose {
  if (!APP_NAME_RE.test(appName)) {
    throw new Error(`Invalid app name: "${appName}"`);
  }

  const result: GeneratedCompose = {
    ports: [],
    sockets: [],
    secretKeys: [],
    agentDeclaration: null,
    warnings: [],
  };

  const namedVolumes = new Set<string>();
  const composeServices: Record<string, unknown> = {};

  // Defense-in-depth: re-validate resource limits even if parseAppYaml was skipped
  if (appYaml.resources !== undefined) {
    validateResources(appYaml.resources);
  }
  const cpu = Math.min(appYaml.resources?.cpu ?? DEFAULT_CPU, MAX_CPU);
  const rawMem = appYaml.resources?.memory ?? DEFAULT_MEMORY;
  const memMB = parseMemoryMB(rawMem);
  if (memMB > MAX_MEMORY_MB) {
    throw new Error(`resources.memory ${rawMem} exceeds maximum of 2G`);
  }
  const memStr = rawMem;

  // Two-pass: collect healthcheck presence for depends_on resolution
  const hasHealthcheck = new Set<string>();
  for (const [svcName, svcDef] of Object.entries(appYaml.services)) {
    if (svcName !== 'agent') {
      const svc = svcDef as AppYamlService;
      if (svc.healthcheck) hasHealthcheck.add(svcName);
    }
  }

  for (const [svcName, svcDef] of Object.entries(appYaml.services)) {
    if (svcName === 'agent') {
      const agentSvc = svcDef as AppYamlAgentService;
      result.agentDeclaration = { path: agentSvc.path, name: agentSvc.name };
      continue;
    }

    const svc = svcDef as AppYamlService;
    const containerName = `${appName}-${svcName}`;
    const composeSvc: Record<string, unknown> = {
      container_name: containerName,
      restart: 'unless-stopped',
      cap_drop: ['ALL'],
      env_file: '.env',
    };

    // build or image
    if (svc.build) {
      const resolved = path.resolve(appDir, svc.build);
      if (!resolved.startsWith(appDir + path.sep) && resolved !== appDir) {
        throw new Error(
          `Service "${svcName}".build must be within the app directory`,
        );
      }
      composeSvc.build = svc.build;
    } else if (svc.image) {
      if (svc.image.endsWith(':latest')) {
        result.warnings.push(
          `Service "${svcName}" uses floating image tag ":latest" — pin to a specific version for reproducible installs`,
        );
      }
      composeSvc.image = svc.image;
    }

    // command / entrypoint (pass through; already validated in parse)
    if (svc.command !== undefined) composeSvc.command = svc.command;
    if (svc.entrypoint !== undefined) composeSvc.entrypoint = svc.entrypoint;
    if (svc.working_dir !== undefined) composeSvc.working_dir = svc.working_dir;
    if (svc.user !== undefined) composeSvc.user = svc.user;

    // environment — static vars only (secrets go to .env via env_file)
    const staticEnv: string[] = [];
    for (const envEntry of svc.environment ?? []) {
      const eqIdx = envEntry.indexOf('=');
      if (eqIdx === -1) {
        // Secret key — not in compose, recorded for installer to prompt
        const key = envEntry.trim();
        if (!result.secretKeys.includes(key)) {
          result.secretKeys.push(key);
        }
      } else {
        staticEnv.push(envEntry);
      }
    }
    if (staticEnv.length > 0) composeSvc.environment = staticEnv;

    // volumes
    const composeVolumes: string[] = [];
    for (const vol of svc.volumes ?? []) {
      composeVolumes.push(vol);
      const src = vol.split(':')[0];
      if (!src.startsWith('/')) {
        namedVolumes.add(src);
      }
    }
    if (composeVolumes.length > 0) composeSvc.volumes = composeVolumes;

    // ports — use containerPort as both host and container port
    for (const portDef of svc.ports ?? []) {
      const portNum = portDef.container;
      composeSvc.ports = (composeSvc.ports as string[] | undefined) ?? [];
      (composeSvc.ports as string[]).push(`${portNum}:${portNum}`);

      result.ports.push({
        name: portDef.name,
        service: svcName,
        containerPort: portNum,
        type: portDef.type ?? 'api',
        rateLimit: portDef.rate_limit ?? 200,
      });
    }

    // depends_on
    if (svc.depends_on && svc.depends_on.length > 0) {
      const dependsObj: Record<string, { condition: string }> = {};
      for (const dep of svc.depends_on) {
        dependsObj[dep] = {
          condition: hasHealthcheck.has(dep) ? 'service_healthy' : 'service_started',
        };
      }
      composeSvc.depends_on = dependsObj;
    }

    // healthcheck
    if (svc.healthcheck) {
      composeSvc.healthcheck = {
        test: ['CMD-SHELL', svc.healthcheck.test],
        interval: svc.healthcheck.interval ?? '30s',
        timeout: svc.healthcheck.timeout ?? '10s',
        retries: svc.healthcheck.retries ?? 3,
      };
    }

    // gateway_api — inject socket volume, record for installer
    if (svc.gateway_api) {
      const hostSockPath = path.join(SOCKET_DIR, `${appName}-${svcName}.sock`);
      const containerSockPath = svc.gateway_api.socket;
      const sockVol = `${hostSockPath}:${containerSockPath}`;
      composeSvc.volumes = [
        ...((composeSvc.volumes as string[] | undefined) ?? []),
        sockVol,
      ];

      const scripts: Record<string, ScriptConfig> = {};
      for (const [scriptName, scriptDef] of Object.entries(
        svc.gateway_api.scripts ?? {},
      )) {
        scripts[scriptName] = {
          path: scriptDef.path,
          timeout: scriptDef.timeout ?? '30s',
          args: scriptDef.args,
        };
      }
      result.sockets.push({
        service: svcName,
        hostSocketPath: hostSockPath,
        scripts,
      });
    }

    // Resource limits (always injected)
    composeSvc.deploy = {
      resources: {
        limits: {
          cpus: String(cpu),
          memory: memStr,
        },
      },
    };

    composeServices[svcName] = composeSvc;
  }

  // Top-level volumes for named volumes
  const composeDoc: Record<string, unknown> = {
    services: composeServices,
  };
  if (namedVolumes.size > 0) {
    const volsObj: Record<string, null> = {};
    for (const v of namedVolumes) volsObj[v] = null;
    composeDoc.volumes = volsObj;
  }

  const banner = '# generated by claude-gateway — do not edit\n';
  const composeYaml = banner + yaml.dump(composeDoc, { lineWidth: 120 });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, composeYaml, 'utf-8');

  return result;
}

// ─── Convenience wrapper ─────────────────────────────────────────────────────

/** Read app.yaml from appDir, parse, validate, and generate docker-compose.yml. */
export function processAppYaml(
  appDir: string,
  appName: string,
  outputPath: string,
): GeneratedCompose {
  const content = fs.readFileSync(path.join(appDir, 'app.yaml'), 'utf-8');
  const appYaml = parseAppYaml(content, appDir);
  return generateCompose(appYaml, appName, appDir, outputPath);
}

// ─── Validators ───────────────────────────────────────────────────────────────

function requireString(obj: Record<string, unknown>, key: string): void {
  if (typeof obj[key] !== 'string' || !obj[key]) {
    throw new Error(`app.yaml: "${key}" is required and must be a non-empty string`);
  }
}

function validateAgentServiceDecl(svcDef: unknown): void {
  if (typeof svcDef !== 'object' || svcDef === null) {
    throw new Error('Agent service declaration must be an object');
  }
  const obj = svcDef as Record<string, unknown>;
  const allowed = new Set(['path', 'name']);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new Error(
        `Agent service declaration has invalid field "${k}" — only "path" and "name" are allowed`,
      );
    }
  }
  if (typeof obj['path'] !== 'string' || !obj['path']) {
    throw new Error('Agent service declaration: "path" is required');
  }
  if (typeof obj['name'] !== 'string' || !AGENT_NAME_RE.test(obj['name'])) {
    throw new Error(
      `Agent service declaration: "name" must match ${AGENT_NAME_RE} (got "${obj['name']}")`,
    );
  }
}

function validateService(
  svcName: string,
  svcDef: unknown,
  appDir: string,
): AppYamlService {
  if (typeof svcDef !== 'object' || svcDef === null) {
    throw new Error(`Service "${svcName}" must be an object`);
  }
  const obj = svcDef as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_SERVICE_FIELDS.has(key)) {
      throw new Error(`Service "${svcName}" has banned field: "${key}"`);
    }
  }

  if (!obj['build'] && !obj['image']) {
    throw new Error(`Service "${svcName}" must have "build" or "image"`);
  }
  if (obj['build'] && obj['image']) {
    throw new Error(`Service "${svcName}" cannot have both "build" and "image"`);
  }

  if (obj['build'] !== undefined) {
    if (typeof obj['build'] !== 'string') {
      throw new Error(`Service "${svcName}".build must be a string`);
    }
    const resolved = path.resolve(appDir, obj['build']);
    if (!resolved.startsWith(appDir + path.sep) && resolved !== appDir) {
      throw new Error(`Service "${svcName}".build must be within the app directory`);
    }
  }

  if (obj['image'] !== undefined) {
    if (typeof obj['image'] !== 'string') {
      throw new Error(`Service "${svcName}".image must be a string`);
    }
    if (!IMAGE_RE.test(obj['image'])) {
      throw new Error(
        `Service "${svcName}".image contains invalid characters (only lowercase, digits, ._-/:@ allowed)`,
      );
    }
  }

  validateCommand(svcName, 'command', obj['command']);
  validateCommand(svcName, 'entrypoint', obj['entrypoint']);

  if (obj['working_dir'] !== undefined && typeof obj['working_dir'] !== 'string') {
    throw new Error(`Service "${svcName}".working_dir must be a string`);
  }
  if (obj['user'] !== undefined && typeof obj['user'] !== 'string') {
    throw new Error(`Service "${svcName}".user must be a string`);
  }

  if (obj['environment'] !== undefined) {
    validateEnvironment(svcName, obj['environment']);
  }

  if (obj['volumes'] !== undefined) {
    validateVolumes(svcName, obj['volumes']);
  }

  if (obj['ports'] !== undefined) {
    validatePorts(svcName, obj['ports']);
  }

  if (obj['depends_on'] !== undefined) {
    if (!Array.isArray(obj['depends_on'])) {
      throw new Error(`Service "${svcName}".depends_on must be an array`);
    }
    for (const dep of obj['depends_on'] as unknown[]) {
      if (typeof dep !== 'string') {
        throw new Error(`Service "${svcName}".depends_on entries must be strings`);
      }
    }
  }

  if (obj['healthcheck'] !== undefined) {
    validateHealthcheck(svcName, obj['healthcheck']);
  }

  if (obj['gateway_api'] !== undefined) {
    validateGatewayApi(svcName, obj['gateway_api'], appDir);
  }

  return svcDef as AppYamlService;
}

function validateCommand(
  svcName: string,
  field: string,
  val: unknown,
): void {
  if (val === undefined) return;
  const tokens = Array.isArray(val) ? val : [val];
  for (const token of tokens) {
    if (typeof token !== 'string') {
      throw new Error(`Service "${svcName}".${field} tokens must be strings`);
    }
    if (/[\n\r\x00]/.test(token)) {
      throw new Error(
        `Service "${svcName}".${field} contains invalid characters (newline/null)`,
      );
    }
  }
}

function validateEnvironment(svcName: string, envList: unknown): void {
  if (!Array.isArray(envList)) {
    throw new Error(`Service "${svcName}".environment must be an array`);
  }
  for (const entry of envList as unknown[]) {
    if (typeof entry !== 'string') {
      throw new Error(`Service "${svcName}".environment entries must be strings`);
    }
    const key = entry.includes('=') ? entry.slice(0, entry.indexOf('=')).trim() : entry.trim();
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(
        `Service "${svcName}".environment key "${key}" must match ${ENV_KEY_RE}`,
      );
    }
    // Strip any newlines from value (value after =)
    if (entry.includes('=') && /[\n\r]/.test(entry.slice(entry.indexOf('=') + 1))) {
      throw new Error(
        `Service "${svcName}".environment entry "${key}" value contains newline characters`,
      );
    }
  }
}

function validateVolumes(svcName: string, volList: unknown): void {
  if (!Array.isArray(volList)) {
    throw new Error(`Service "${svcName}".volumes must be an array`);
  }
  for (const vol of volList as unknown[]) {
    if (typeof vol !== 'string') {
      throw new Error(`Service "${svcName}".volumes entries must be strings`);
    }
    const parts = vol.split(':');
    if (parts.length < 2 || parts.length > 3) {
      throw new Error(`Service "${svcName}".volumes entry is malformed: "${vol}"`);
    }
    const [src, target, mode] = parts;
    if (!src || !target) {
      throw new Error(`Service "${svcName}".volumes entry is malformed: "${vol}"`);
    }

    if (src.startsWith('/')) {
      // Host mount — validate absolute, no traversal, no symlinks
      const resolved = path.resolve(src);
      if (resolved !== src) {
        throw new Error(
          `Service "${svcName}".volumes source contains path traversal: "${src}"`,
        );
      }
      try {
        if (fs.lstatSync(src).isSymbolicLink()) {
          throw new Error(
            `Service "${svcName}".volumes source must not be a symlink: "${src}"`,
          );
        }
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') throw e; // path doesn't exist yet — OK
      }
    } else {
      // Named volume
      if (!NAMED_VOLUME_RE.test(src)) {
        throw new Error(
          `Service "${svcName}".volumes named volume must match ${NAMED_VOLUME_RE}: "${src}"`,
        );
      }
    }

    if (!target.startsWith('/')) {
      throw new Error(
        `Service "${svcName}".volumes target must be an absolute path: "${target}"`,
      );
    }
    if (target.includes('..')) {
      throw new Error(
        `Service "${svcName}".volumes target contains path traversal: "${target}"`,
      );
    }

    if (mode !== undefined && mode !== 'ro' && mode !== 'rw') {
      throw new Error(
        `Service "${svcName}".volumes mode must be "ro" or "rw": "${mode}"`,
      );
    }
  }
}

function validatePorts(svcName: string, portList: unknown): void {
  if (!Array.isArray(portList)) {
    throw new Error(`Service "${svcName}".ports must be an array`);
  }
  const seen = new Set<number>();
  for (const portDef of portList as unknown[]) {
    if (typeof portDef !== 'object' || portDef === null) {
      throw new Error(`Service "${svcName}".ports entries must be objects`);
    }
    const p = portDef as Record<string, unknown>;
    if (typeof p['name'] !== 'string' || !p['name']) {
      throw new Error(`Service "${svcName}".ports entry missing "name"`);
    }
    if (typeof p['container'] !== 'number' || !Number.isInteger(p['container'])) {
      throw new Error(
        `Service "${svcName}".ports["${p['name']}"].container must be an integer`,
      );
    }
    const port = p['container'] as number;
    if (port < 1024 || BANNED_PORTS.has(port)) {
      throw new Error(
        `Service "${svcName}".ports["${p['name']}"].container ${port} is banned`,
      );
    }
    if (seen.has(port)) {
      throw new Error(
        `Service "${svcName}".ports has duplicate container port ${port}`,
      );
    }
    seen.add(port);
    if (p['type'] !== undefined && p['type'] !== 'api' && p['type'] !== 'web') {
      throw new Error(
        `Service "${svcName}".ports["${p['name']}"].type must be "api" or "web"`,
      );
    }
    if (p['rate_limit'] !== undefined) {
      if (typeof p['rate_limit'] !== 'number' || p['rate_limit'] <= 0) {
        throw new Error(
          `Service "${svcName}".ports["${p['name']}"].rate_limit must be a positive number`,
        );
      }
    }
  }
}

function validateHealthcheck(svcName: string, hc: unknown): void {
  if (typeof hc !== 'object' || hc === null) {
    throw new Error(`Service "${svcName}".healthcheck must be an object`);
  }
  const obj = hc as Record<string, unknown>;
  if (typeof obj['test'] !== 'string' || !obj['test']) {
    throw new Error(`Service "${svcName}".healthcheck.test must be a non-empty string`);
  }
}

function validateGatewayApi(
  svcName: string,
  gatewayApi: unknown,
  appDir: string,
): void {
  if (typeof gatewayApi !== 'object' || gatewayApi === null) {
    throw new Error(`Service "${svcName}".gateway_api must be an object`);
  }
  const obj = gatewayApi as Record<string, unknown>;
  if (typeof obj['socket'] !== 'string' || !obj['socket']) {
    throw new Error(`Service "${svcName}".gateway_api.socket must be a non-empty string`);
  }
  if (obj['scripts'] !== undefined) {
    if (typeof obj['scripts'] !== 'object' || obj['scripts'] === null) {
      throw new Error(`Service "${svcName}".gateway_api.scripts must be an object`);
    }
    for (const [scriptName, scriptDef] of Object.entries(
      obj['scripts'] as Record<string, unknown>,
    )) {
      validateScript(svcName, scriptName, scriptDef, appDir);
    }
  }
}

function validateScript(
  svcName: string,
  scriptName: string,
  scriptDef: unknown,
  appDir: string,
): void {
  if (typeof scriptDef !== 'object' || scriptDef === null) {
    throw new Error(
      `Service "${svcName}".gateway_api.scripts["${scriptName}"] must be an object`,
    );
  }
  const obj = scriptDef as Record<string, unknown>;
  if (typeof obj['path'] !== 'string' || !obj['path']) {
    throw new Error(
      `Service "${svcName}".gateway_api.scripts["${scriptName}"].path must be a string`,
    );
  }
  const scriptPath = obj['path'] as string;
  if (scriptPath.startsWith('/')) {
    throw new Error(
      `Service "${svcName}".gateway_api.scripts["${scriptName}"].path must be relative (not absolute)`,
    );
  }
  if (!scriptPath.endsWith('.sh')) {
    throw new Error(
      `Service "${svcName}".gateway_api.scripts["${scriptName}"].path must be a .sh file`,
    );
  }
  const resolved = path.resolve(appDir, scriptPath);
  if (!resolved.startsWith(appDir + path.sep) && resolved !== appDir) {
    throw new Error(
      `Service "${svcName}".gateway_api.scripts["${scriptName}"].path must be within the app directory`,
    );
  }
}

function validateResources(resources: unknown): void {
  if (typeof resources !== 'object' || resources === null) {
    throw new Error('app.yaml: "resources" must be an object');
  }
  const obj = resources as Record<string, unknown>;
  if (obj['cpu'] !== undefined) {
    if (typeof obj['cpu'] !== 'number' || obj['cpu'] <= 0) {
      throw new Error('app.yaml: resources.cpu must be a positive number');
    }
    if (obj['cpu'] > MAX_CPU) {
      throw new Error(
        `app.yaml: resources.cpu ${obj['cpu']} exceeds maximum of ${MAX_CPU}`,
      );
    }
  }
  if (obj['memory'] !== undefined) {
    if (typeof obj['memory'] !== 'string') {
      throw new Error('app.yaml: resources.memory must be a string (e.g. "256M", "1G")');
    }
    const mb = parseMemoryMB(obj['memory']);
    if (mb > MAX_MEMORY_MB) {
      throw new Error(
        `app.yaml: resources.memory ${obj['memory']} exceeds maximum of 2G`,
      );
    }
  }
}

function parseMemoryMB(mem: string): number {
  const m = mem.match(/^(\d+(?:\.\d+)?)\s*([MG])$/i);
  if (!m) {
    throw new Error(
      `Invalid memory format: "${mem}" (expected e.g. "256M", "1G")`,
    );
  }
  const [, num, unit] = m;
  return unit.toUpperCase() === 'G' ? parseFloat(num) * 1024 : parseFloat(num);
}
