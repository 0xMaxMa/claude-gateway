import { spawn } from 'child_process';
import { openSync, closeSync } from 'fs';
import { resolve, join } from 'path';
import { SafemodeStore, alive } from '../../safemode/store';
import { getRequest, stopSession } from '../../safemode/runner';
import { GatewayTaskTarget, TaskSnapshot, WorkerOutcome, OrchestrationError } from '../types';
import { GatewayTaskAdapter } from './controller';

export class SafemodeTaskAdapter implements GatewayTaskAdapter {
  readonly name = 'safemode';
  constructor(private readonly agentId: string, private readonly allowed: () => boolean, private readonly createStore = () => new SafemodeStore()) {}
  private authorize(): void {
    if (!this.allowed()) throw new OrchestrationError('SAFEMODE_AGENT_NOT_ALLOWED');
  }
  discover(query = '', offset = 0): unknown {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new OrchestrationError('INVALID_INPUT');
    this.authorize();
    const store = this.createStore();
    const sessions = store.list().filter(s => s.agentId === this.agentId && s.nativeSessionId && s.nativeStarted !== false && (!query || `${s.name} ${s.id}`.toLowerCase().includes(query.toLowerCase())))
      .sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    return {scope:'safemode', sessions:sessions.slice(offset,offset+100).map(s => {
      const owner = store.owner(s.id);
      return {id:s.id,name:s.name,cli:s.cli,model:s.model,status: owner ? (alive(owner.pid) || alive(owner.childPid) ? owner.mode : 'recovery_required') : 'idle'};
    }), total:sessions.length, next_offset:offset+100<sessions.length?offset+100:null,
    instruction:'Discovery only. To send work, use task_spawn target_profile=gateway-managed with gateway_target.adapter=safemode and session_id. Set takeover only with explicit user authorization. Completion is reported automatically.'};
  }
  resolve(input: Record<string, unknown>): GatewayTaskTarget {
    this.authorize();
    if (input.adapter !== 'safemode' || typeof input.session_id !== 'string' ||
      Object.keys(input).some(k => !['adapter','session_id','takeover','no_bootstrap'].includes(k)) ||
      (input.takeover !== undefined && typeof input.takeover !== 'boolean') ||
      (input.no_bootstrap !== undefined && typeof input.no_bootstrap !== 'boolean')) throw new OrchestrationError('INVALID_GATEWAY_TARGET');
    const store = this.createStore();
    // Resolve only within this agent's inventory, so a known foreign ID and
    // a nonexistent ID have the same response (no existence oracle).
    const sessions = store.list().filter(s => s.agentId === this.agentId && (s.id === input.session_id || s.name === input.session_id));
    const session = sessions.length === 1 ? sessions[0] : undefined;
    if (!session) throw new OrchestrationError('SAFEMODE_SESSION_NOT_AVAILABLE');
    if (!session.nativeSessionId || session.nativeStarted === false) throw new OrchestrationError('SAFEMODE_NATIVE_SESSION_REQUIRED');
    return {adapter:this.name,sessionId:session.id,name:session.name,takeover:input.takeover===true,noBootstrap:input.no_bootstrap===true};
  }
  private assertTask(task: TaskSnapshot): void {
    if (task.agentId !== this.agentId || task.gatewayTarget?.adapter !== this.name) throw new OrchestrationError('ACCESS_DENIED');
  }
  ready(task: TaskSnapshot): boolean {
    this.assertTask(task);
    this.authorize();
    const store = this.createStore();
    if (store.read(task.gatewayTarget!.sessionId).agentId !== this.agentId) throw new OrchestrationError('SAFEMODE_SESSION_NOT_AVAILABLE');
    const owner = store.owner(task.gatewayTarget!.sessionId);
    if (owner && !alive(owner.pid) && !alive(owner.childPid)) {
      throw new OrchestrationError('SAFEMODE_RECOVERY_REQUIRED',
        'The safemode owner has exited. Ask the operator to run safemode recover for this investigation before retrying. No request was sent and the ownership lock was preserved.');
    }
    // Wait for another headless request; never take it over implicitly.
    return !owner || (owner.mode === 'interactive' && task.gatewayTarget!.takeover === true);
  }
  async submit(task: TaskSnapshot, requestId: string, instructions: string): Promise<void> {
    this.assertTask(task);
    this.authorize();
    if (instructions.length > 100000) throw new OrchestrationError('PAYLOAD_TOO_LARGE');
    const store = this.createStore(), target = task.gatewayTarget!;
    if (store.read(target.sessionId).agentId !== this.agentId) throw new OrchestrationError('SAFEMODE_SESSION_NOT_AVAILABLE');
    // Fixed CLI argv, no shell, no arbitrary native flags or executable selection.
    const args = [resolve(__dirname, '../../entry.js'),'safemode','send',target.sessionId,`--prompt=${instructions}`,`--request-id=${requestId}`,`--agent-id=${this.agentId}`,'--wait'];
    if (target.takeover) args.push('--takeover');
    if (target.noBootstrap) args.push('--no-bootstrap');
    const fd = openSync(join(store.dir(target.sessionId),`task-${requestId}.log`),'a',0o600);
    try {
      await new Promise<void>((ok,fail) => {
        const child = spawn(process.execPath,args,{detached:true,stdio:['ignore',fd,fd]});
        child.once('error',fail);
        child.once('spawn',() => { child.unref(); ok(); });
      });
    } finally { closeSync(fd); }
  }
  async inspect(task: TaskSnapshot, requestId: string): Promise<WorkerOutcome | 'running' | 'pending'> {
    this.assertTask(task);
    // Existing committed work remains trackable after allowlist revocation. No
    // new operation is authorized here and no other request's log is read.
    const store = this.createStore(), target = task.gatewayTarget!;
    const request = getRequest(store,target.sessionId,requestId);
    if (!request) return 'pending';
    if (request.status === 'completed') return request.result
      ? {type:'completed',result:{summary:request.result,artifactIds:[]}}
      : {type:'failed',failure:{code:'SAFEMODE_RESULT_MISSING',message:'The native request exited successfully but no final response was recorded. Inspect this request before retrying.',observedAt:Date.now()}};
    if (request.status === 'failed') return {type:'failed',failure:{code:'SAFEMODE_REQUEST_FAILED',message:request.error || `Safemode exited with code ${request.exitCode ?? 'unknown'}.`,observedAt:Date.now()}};
    const owner = store.owner(target.sessionId);
    if (owner && request.ownerToken && owner.token === request.ownerToken && (alive(owner.pid) || alive(owner.childPid))) return 'running';
    return {type:'unknown',failure:{code:'SAFEMODE_OWNER_LOST',message:'Request has no matching live owner. No replacement request was sent.',observedAt:Date.now()}};
  }
  async cancel(task: TaskSnapshot, requestId: string): Promise<void> {
    this.assertTask(task);
    const store = this.createStore(), id = task.gatewayTarget!.sessionId;
    const request = getRequest(store,id,requestId), owner = store.owner(id);
    if (!request || request.status !== 'running' || !owner) return;
    // Only the owner recorded on THIS request can be stopped, even if a newer
    // interactive or headless request has already acquired the same session.
    if (!request.ownerToken || request.ownerToken !== owner.token) throw new OrchestrationError('SAFEMODE_OWNER_CHANGED');
    await stopSession(store,id,owner);
  }
}
