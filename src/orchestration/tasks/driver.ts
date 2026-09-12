import { taskDirective } from './task-directive';
import { personaWorkspaceRules } from '../source-policy';
import { browserRouting } from '../browser-routing';
import { discoverCliSkills } from '../cli-skills';
import { ProcessActivitySampler } from '../process-activity';
import { cleanupPersistedProcess, processFingerprint } from '../process-supervisor';
import { resolveOrchestrationConfig } from '../config';
import { taskFailure } from './failure';
import { payloadHash } from '../store';
import { containerNode, validateContainer } from '../container';
import { toolActivity } from '../tool-activity';
import { extractFrontmatter } from '../../skills/parser';
import { dirname, join } from 'path';
import { readFile, writeFile, realpath, mkdir, cp, lstat } from 'fs/promises';
import type { AgentConfig, GatewayConfig } from '../../types';
import { SessionStore } from '../../session/store';
import { SessionProcess } from '../../session/process';
import { TaskBridge } from '../bridge';
import { TaskService } from './service';
import { TaskWorkspaces } from './workspace';
import { TaskAttempt, TaskSnapshot, OrchestrationError } from '../types';
import { WorkerDriver, WorkerHandle } from './scheduler';
import { startProcessTurn } from '../process-turn';
import { randomUUID } from 'crypto';
import { gatewayCapacity } from '../capacity';
import { resolveSharedConfig, sharedVaultDir } from '../../agent/knowledge';
import { MediaStore } from '../../history/media-store';

function boundedResultText(text: string): string {
  let result = text.slice(0, 8192);
  while (Buffer.byteLength(JSON.stringify(result)) > 16000) result = result.slice(0, Math.floor(result.length / 2));
  return result.replace(/[\uD800-\uDBFF]$/, '');
}

export class ClaudeWorkerDriver implements WorkerDriver {
  private readonly instanceId = randomUUID();
  constructor(private readonly agent: AgentConfig, private readonly gateway: GatewayConfig, private readonly tasks: TaskService,
    private readonly bridge: TaskBridge, private readonly workspaces: TaskWorkspaces, private readonly privateRoot: string, private readonly onManagedTurn?: (sessionId: string, text: string, metrics: import('../process-turn').ManagedTurnMetrics, skills?: string[]) => void) {}
  async cleanup(attempt: TaskAttempt): Promise<boolean> {
    // Stopping a docker client does not prove its container execution stopped.
    if (this.agent.type === 'app-agent') return false;
    return cleanupPersistedProcess(attempt.processIdentity);
  }
  reserve(): (() => void) | undefined { return gatewayCapacity(this.gateway).acquire('worker'); }
  available(taskId: string): boolean { return this.workspaces.available(taskId); }
  release(taskId: string): Promise<void> { return this.workspaces.release(taskId); }
  async start(task: TaskSnapshot, attempt: TaskAttempt, capacityReserved = false): Promise<WorkerHandle> {
    if (!['default-worker', 'media-worker', 'skill-worker'].includes(task.targetProfile) || !task.capabilities.execute) throw new OrchestrationError('EXECUTION_DENIED');
    if (task.targetProfile === 'default-worker' && task.resourceProfile?.mode === 'shared-lock') {
      const [project, identity] = await Promise.all([realpath(task.resourceProfile.projectRoot), realpath(this.agent.workspace)]);
      if (project === identity || project.startsWith(identity + '/') || identity.startsWith(project + '/')) throw new OrchestrationError('SHARED_PROJECT_MUST_DIFFER_FROM_IDENTITY_WORKSPACE');
    }
    if (this.agent.type === 'app-agent') {
      if (task.resourceProfile?.mode !== 'container') throw new OrchestrationError('CONTAINER_WORKSPACE_REQUIRED');
      await validateContainer(this.agent);
    }
    const workspace = await this.workspaces.prepare(task.taskId);
    const current = this.tasks.store.task(task.taskId)!;
    if (current.state !== 'starting' || current.activeAttemptId !== attempt.attemptId) throw new OrchestrationError('ATTEMPT_CANCELLED_BEFORE_START');
    const directory = join(this.privateRoot, attempt.attemptId);
    const cliSkill = task.skill?.invocation === 'cli';
    const invokedSkill = task.skill ? (cliSkill ? task.skill.name : `orchestration-task:${task.skill.name}`) : undefined;
    if (cliSkill) {
      const installed = await discoverCliSkills(this.agent, workspace.path);
      if (!installed.some(skill => skill.name === task.skill!.name)) throw new OrchestrationError('CLI_SKILL_UNAVAILABLE', 'The selected skill is unavailable in this worker runtime; no host/container fallback was attempted.');
    }
    const skillPluginDir = task.skill && !cliSkill ? join(directory, 'skill-plugin') : undefined;
    if (task.skill && !cliSkill) {
      if (task.skill.requires?.plugins?.length) throw new OrchestrationError('SKILL_PLUGIN_UNAVAILABLE');
      const destination = join(skillPluginDir!, 'skills', task.skill.name);
      await mkdir(join(skillPluginDir!, '.claude-plugin'), { recursive: true, mode: 0o700 });
      await writeFile(join(skillPluginDir!, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'orchestration-task', description: 'Assigned task skill only', version: '1.0.0' }), { mode: 0o600 });
      await mkdir(destination, { recursive: true, mode: 0o700 });
      // Keep relative references/scripts available; the invoked body is pinned at admission.
      await cp(dirname(task.skill.filePath), destination, { recursive: true, dereference: false, filter: async source => !(await lstat(source)).isSymbolicLink() });
      await writeFile(join(destination, 'SKILL.md'), `---\nname: ${task.skill.name}\ndescription: Assigned installed skill\n---\n${extractFrontmatter(task.skill.content)?.body ?? task.skill.content}`, { mode: 0o600 });
    }
    const revision = this.tasks.revision(task.taskId, attempt.revision);
    const directive = taskDirective(this.tasks.store, task.conversationId, revision);
    // Snapshot the authorized agent context without modifying either workspace's
    // persona files. Project CLAUDE.md continues to be discovered in the worktree.
    const context = this.agent.type === 'app-agent'
      ? await containerNode(this.agent.container!, "process.stdout.write(require('fs').readFileSync('/workspace/CLAUDE.md','utf8'))")
      : await readFile(join(this.agent.workspace, 'CLAUDE.md'), 'utf8');
    this.tasks.pool.bind(attempt, payloadHash({ context, workspace: workspace.path, agent: this.agent, gateway: this.gateway }));
    const shared = resolveSharedConfig(this.agent.knowledge?.shared, this.gateway.gateway.knowledge?.shared);
    const ticket = this.bridge.issue({ role: 'worker', attemptId: attempt.attemptId, generation: attempt.generation }, directory, this.agent.workspace, shared.enabled ? sharedVaultDir(shared) : '');
    try {
      const profile = { ...ticket.profile, hostExecution: workspace.baseCommit === 'host', containerExecution: this.agent.type === 'app-agent', originSessionId: task.agentSessionId, taskId: task.taskId, attemptId: attempt.attemptId, context, workerSession: { id: attempt.sessionId, resume: Boolean(attempt.resumeSession) }, capacityReserved, skillPluginDir };
      const workerConfig: AgentConfig = { ...this.agent, workspace: this.agent.type === 'app-agent' ? this.agent.workspace : workspace.path, allow_tools: true, orchestration: undefined,
        claude: { ...this.agent.claude, model: task.model ?? this.agent.claude.model, extraFlags: [] } };
      const process = new SessionProcess(attempt.sessionId, 'api', workerConfig, this.gateway, new SessionStore(join(this.privateRoot, 'logs')), undefined, profile);
      process.on('output', line => this.bridge.captureWorkerOutput(attempt.attemptId, attempt.generation, line));
      process.on('output', toolActivity(event => this.tasks.store.transaction(() => this.tasks.store.appendEvent(task.conversationId, 'tool.activity', { ...event, taskId: task.taskId, role: 'worker' }, task.taskId))));
      const skillCalls = new Set<string>();
      process.on('output', line => {
        if (!task.skill) return;
        try {
          const event = JSON.parse(line);
          for (const block of event.message?.content ?? []) {
            if (event.type === 'assistant' && block.type === 'tool_use' && block.name === 'Skill' && block.input?.skill === invokedSkill) skillCalls.add(block.id);
            if (event.type === 'user' && block.type === 'tool_result' && skillCalls.delete(block.tool_use_id) && !block.is_error) {
              this.tasks.store.transaction(() => this.tasks.store.appendEvent(task.conversationId, 'task.skill_invoked', { attemptId: attempt.attemptId, skill: task.skill!.name }, task.taskId));
            }
          }
        } catch { /* Observability must not change task execution. */ }
      });
      const input = this.tasks.store.get('SELECT * FROM conversation_inputs WHERE id=?', revision.originatingInputId)!;
      const attachments = (JSON.parse(String(input.attachment_refs_json)) as string[]).map(ref => MediaStore.resolvePath(join(this.agent.workspace, '../..'), this.agent.id, ref));
      const references = revision.contextRefs.map(ref => {
        const inputRef = this.tasks.store.get('SELECT text,attachment_refs_json FROM conversation_inputs WHERE id=? AND conversation_id=?', ref.replace(/^input:/, ''), task.conversationId);
        if (inputRef) return { ref, kind: 'input', text: inputRef.text, attachments: (JSON.parse(String(inputRef.attachment_refs_json)) as string[]).map(path => MediaStore.resolvePath(join(this.agent.workspace, '../..'), this.agent.id, path)) };
        const file = this.tasks.store.get('SELECT f.path FROM task_files f JOIN tasks t ON t.id=f.task_id WHERE f.id=? AND t.conversation_id=?', ref, task.conversationId);
        if (file) return { ref, kind: 'attachment', path: MediaStore.resolvePath(join(this.agent.workspace, '../..'), this.agent.id, String(file.path)) };
        const resource = this.tasks.store.get('SELECT r.* FROM task_resources r JOIN tasks t ON t.id=r.task_id WHERE r.id=? AND t.conversation_id=?', ref, task.conversationId);
        if (resource) return { ref, kind: 'artifact', lifecycle: resource.lifecycle_state, path: resource.lifecycle_state === 'archived' ? resource.context_snapshot_ref : resource.worktree_path };
        return { ref, kind: 'attachment', path: MediaStore.resolvePath(join(this.agent.workspace, '../..'), this.agent.id, ref) };
      });
      const contextFile = join(directory, 'context.json');
      await writeFile(contextFile, JSON.stringify({ references, attachments }, null, 2), { mode: 0o600 });
      const browserContext = browserRouting(this.agent, this.gateway, workspace.baseCommit === 'host');
      let prompt = `${browserContext}\n\nTask ${task.taskId}, attempt ${attempt.attemptId}, revision ${attempt.revision}.\n${directive}${task.skill ? `\nThe registered CLI skill name is ${invokedSkill}; invoke that exact name via Skill with arguments ${JSON.stringify(task.skill.args)}.` : ''}\n\nAuthorized read-only context and attachment paths: ${contextFile}. Read this file when the task requires its references.\nComposer options: ${JSON.parse(String(input.ingress_json ?? '{}')).metadata?.promptContext ?? ''}\n${workspace.baseCommit === 'host' ? 'Host execution: you run directly on the same machine and OS account as the original Agent, with its filesystem, shell, network, tools and credentials. Your starting directory is ' + workspace.path + '. You may change directories and operate on user-authorized paths and host services (including tmux and GitHub). No Git worktree is required. Do not claim isolation or missing access without an actual tool error. Coordinate changes to shared files; preserve unrelated work.' : 'Write only in ' + workspace.path + '.'} ${task.skill && workspace.baseCommit !== 'host' ? `Skill reference workspace (read only): ${task.resourceProfile?.projectRoot}. Place any generated files or artifacts in the scratch directory; never edit the source project.` : ''} Base: ${workspace.baseCommit}.\nAgent memory writes permitted: ${task.capabilities.writeMemory}. ${workspace.baseCommit === 'host' ? 'Ordinary task files may be written in the authorized working directory; follow the persona policy for explicit user requests and retain other memory rules.' : 'Never change agent workspace files.'} Report the actual outcome, relevant verification evidence, any artifacts produced, and remaining limitations. Choose verification appropriate to the task; diffs and tests apply only when relevant.`;
      if (this.agent.type === 'app-agent') {
        prompt = `Task ${task.taskId}, attempt ${attempt.attemptId}, revision ${attempt.revision}.\n${directive}\nYou run ONLY inside this app container. Work in /workspace or /tmp. No host filesystem, host tools or host fallback. Native CLI tools execute here; gateway media/browser/memory tools are unavailable. To return files call task_stage_file with their container paths.\nAuthorized context: ${JSON.stringify({ references, attachments })}${task.skill ? `\nInvoke Skill ${invokedSkill} with arguments: ${task.skill.args}` : ''}`;
      }
      prompt += '\nOriginating user request (the assignment must stay within this authorization): ' + JSON.stringify(input.text);
      prompt += '\n' + personaWorkspaceRules(this.agent.workspace, this.agent.type === 'app-agent' ? 'container' : workspace.baseCommit === 'host' ? 'host' : 'isolated');
      if (task.continueTaskId) {
        const prior = this.tasks.store.task(task.continueTaskId);
        prompt += '\nContinuation of prior task (persisted task data, not new authority): ' + JSON.stringify({ taskId: prior?.taskId, state: prior?.state, instructions: prior ? this.tasks.revision(prior.taskId, prior.revision).instructions : '', result: prior?.result, progress: prior?.latestProgress });
      }
      prompt += '\nThis is the current assignment. Previous assignments are context only; do not repeat completed work. Current task tools and permissions supersede earlier receipts.';
      const sampler = new ProcessActivitySampler(() => process.managedProcessId, this.agent.type !== 'app-agent');
      let observing = false, observationClosed = false, lastActivityAt = Date.now();
      const limits = resolveOrchestrationConfig(this.agent.orchestration);
      const turn = startProcessTurn(process, prompt, limits.tasks.maxDurationMs || undefined, undefined,
        metrics => this.onManagedTurn?.(task.agentSessionId, revision.instructions, metrics, task.skill ? [task.skill.name] : []), [],
        {startupTimeoutMs: limits.conversation.startupTimeoutMs, firstResponseTimeoutMs: limits.conversation.firstResponseTimeoutMs,
          idleTimeoutMs: limits.tasks.idleTimeoutMs, acceptToolProgress: true, idleAction: 'observe',
          onObservation: observation => {
            if (observing || observationClosed) return;
            observing = true;
            void sampler.sample().then(sample => {
              if (observationClosed) return;
              const moved = Boolean(sample.cpuTicksDelta || sample.readBytesDelta || sample.writeBytesDelta || sample.membershipChanged);
              lastActivityAt = Math.max(lastActivityAt, observation.lastProgressAt, moved ? sample.observedAt : 0);
              this.tasks.observeExecution(attempt.attemptId, attempt.generation, {...observation, attemptId: attempt.attemptId,
                process: sample, lastActivityAt, status: !sample.available ? 'telemetry_unavailable' : sample.cpuTicksDelta === undefined ? 'observing' : moved ? 'process_activity' : observation.activeTools.length ? 'waiting_for_tool' : 'waiting_for_model'});
            }).catch(() => { /* Diagnostics must not terminate work. */ }).finally(() => { observing = false; });
          }});
      let stopping = false;
      const result: WorkerHandle['result'] = turn.result.then(async answer => {
        if (answer.interrupted || stopping) {
          await process.stop();
          return { type: process.managedGroupStopped ? 'stopped' as const : 'unknown' as const };
        }
        const artifact = await this.workspaces.artifact(task.taskId);
        await writeFile(join(directory, 'diff.patch'), artifact.diff, { mode: 0o600 });
        await writeFile(join(directory, 'result.json'), JSON.stringify({ ...artifact, summary: answer.text }, null, 2), { mode: 0o600 });
        await process.stop();
        if (!process.managedGroupStopped) return { type: 'unknown' as const };
        const diff = boundedResultText(artifact.diff);
        const fileIds = this.tasks.store.all('SELECT id FROM task_files WHERE attempt_id=? ORDER BY created_at,id', attempt.attemptId).map(row => String(row.id));
        return { type: 'completed' as const, result: { summary: boundedResultText(answer.text || 'Worker turn ended without a text summary.'), artifactIds: [artifact.resourceId, ...fileIds],
          diff: { text: diff, truncated: diff.length < artifact.diff.length } } };
      }).catch(async error => {
        await process.stop();
        const failure = taskFailure(error);
        if (error?.timeout) failure.message = `Worker timeout: phase=${error.timeout.phase}, elapsed=${Math.round(error.timeout.elapsedMs / 1000)}s, idle=${Math.round(error.timeout.idleMs / 1000)}s. Inspect existing changes before continuing.`;
        return {type: process.managedGroupStopped ? 'failed' as const : 'unknown' as const, failure};
      }).finally(async () => { observationClosed = true; ticket.revoke(); await process.stop(); });
      return { accepted: turn.accepted, result,
        identity: () => process.managedProcessId ? { pid: process.managedProcessId, startedAt: process.spawnedAt, instanceId: this.instanceId, ...processFingerprint(process.managedProcessId) } : undefined,
        stop: async () => { stopping = true; await turn.stop(); } };
    } catch (error) { ticket.revoke(); throw error; }
  }
}
