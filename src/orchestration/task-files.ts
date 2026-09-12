import { realpathSync, statSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, existsSync, lstatSync, unlinkSync } from 'fs';
import { join, relative, isAbsolute, basename, dirname } from 'path';
import { randomUUID, createHash } from 'crypto';
import { OrchestrationStore, boundedText, payloadHash } from './store';
import { OrchestrationError } from './types';
import { ingestOrchestrationMedia } from './media';
import { MediaStore } from '../history/media-store';
import { detectImageMime } from '../share/share-store';

export class TaskFiles {
  constructor(readonly store: OrchestrationStore, readonly agentsRoot: string, private readonly containerSpool?: string) {}
  private readonly capturedImages = new Map<string, Map<string, string>>();
  private readonly pendingImageTools = new Map<string, Set<string>>();

  /** Capture actual MCP image bytes, never model-authored paths or assistant text. */
  captureOutput(attemptId: string, generation: number, line: string): void {
    if (this.containerSpool) return; // Container output must use the container import boundary.
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    const blocks = event.message?.content;
    if (!Array.isArray(blocks)) return;
    const pending = this.pendingImageTools.get(attemptId) ?? new Set<string>();
    this.pendingImageTools.set(attemptId, pending);
    for (const block of blocks) {
      if (event.type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith('mcp__') && typeof block.id === 'string') pending.add(block.id);
      if (event.type !== 'user' || block.type !== 'tool_result' || !pending.delete(block.tool_use_id) || block.is_error || !Array.isArray(block.content)) continue;
      const image = block.content.find((item: any) => item.type === 'image');
      const data = image?.source?.type === 'base64' ? image.source.data : image?.data;
      if (typeof data !== 'string' || data.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) continue;
      const bytes = Buffer.from(data, 'base64');
      const mime = detectImageMime(bytes.subarray(0, 12));
      if (!mime || !bytes.length || bytes.length > 20 * 1024 * 1024) continue;
      const { mediaDir } = this.scope(attemptId, generation);
      const images = this.capturedImages.get(attemptId) ?? new Map<string, string>();
      if (images.has(block.tool_use_id)) continue;
      if (images.size >= 20) {
        const oldest = images.entries().next().value!;
        try { unlinkSync(oldest[1]); } catch { /* already removed */ }
        images.delete(oldest[0]);
      }
      mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
      const suffix = mime === 'image/png' ? '.png' : mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.gif';
      const file = join(mediaDir, `mcp-image-${randomUUID()}${suffix}`);
      writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      images.set(block.tool_use_id, file);
      this.capturedImages.set(attemptId, images);
    }
  }
  releaseCaptured(attemptId: string): void {
    this.pendingImageTools.delete(attemptId);
    for (const path of this.capturedImages.get(attemptId)?.values() ?? []) {
      try { unlinkSync(path); } catch { /* staged bytes live independently in content-addressed media */ }
    }
    this.capturedImages.delete(attemptId);
  }
  scope(attemptId: string, generation: number) {
    const attempt = this.store.get('SELECT * FROM task_attempts WHERE id=?', attemptId);
    const task = attempt && this.store.task(String(attempt.task_id));
    // The serialized attempt is authoritative; never borrow a later generation.
    const snapshot = attempt && JSON.parse(String(attempt.payload_json));
    if (!task || task.activeAttemptId !== attemptId || snapshot.generation !== generation || !['starting','running'].includes(task.state)) throw new OrchestrationError('STALE_ATTEMPT');
    const conversation = this.store.get('SELECT * FROM conversations WHERE id=?', task.conversationId)!;
    const mediaDir = join(this.agentsRoot, this.store.agentId, 'media', `api-${task.agentSessionId}`);
    return { task, conversation, mediaDir };
  }
  allowedPath(attemptId: string, generation: number, candidate: unknown): string {
    const { task, mediaDir } = this.scope(attemptId, generation);
    const value = boundedText(candidate, 4096);
    const path = realpathSync(value.startsWith('media/') ? MediaStore.resolvePath(this.agentsRoot, this.store.agentId, value) : value);
    const under = (root: string) => { const ref = relative(realpathSync(root), path); return !!ref && !ref.startsWith('..') && !isAbsolute(ref); };
    if (this.containerSpool) {
      if (!under(join(this.containerSpool, attemptId)) || !statSync(path).isFile()) throw new OrchestrationError('ARTIFACT_PATH_DENIED');
      return path;
    }
    let permitted = false;
    try { permitted = under(mediaDir); } catch { /* not created yet */ }
    for (const row of this.store.all("SELECT worktree_path FROM task_resources WHERE task_id=? AND lifecycle_state='active'", task.taskId)) {
      try { permitted ||= under(String(row.worktree_path)); } catch { /* unavailable resource */ }
    }
    for (const row of this.store.all('SELECT attachment_refs_json FROM conversation_inputs WHERE conversation_id=?', task.conversationId)) {
      for (const ref of JSON.parse(String(row.attachment_refs_json)) as string[]) {
        try { permitted ||= realpathSync(MediaStore.resolvePath(this.agentsRoot, this.store.agentId, ref)) === path; } catch { /* expired attachment */ }
      }
    }
    if (!permitted || !statSync(path).isFile()) throw new OrchestrationError('ARTIFACT_PATH_DENIED', 'ARTIFACT_PATH_DENIED: File is outside this task scope. Use the original file’s absolute path in the active task workspace, a supplied input attachment, or this session’s media directory. Do not copy it to the agent-wide media root. The gateway stages authorized files automatically.');
    return path;
  }
  stage(attemptId: string, generation: number, actionId: string, args: Record<string, unknown>) {
    const { task } = this.scope(attemptId, generation);
    boundedText(actionId, 256);
    const old = this.store.get('SELECT * FROM task_files WHERE attempt_id=? AND action_id=?', attemptId, actionId);
    if (old) {
      if (old.args_hash !== payloadHash(args)) throw new OrchestrationError('IDEMPOTENCY_CONFLICT');
      return { artifactId: String(old.id), path: String(old.path), staged: true };
    }
    if (Number(this.store.get('SELECT COUNT(*) n FROM task_files WHERE attempt_id=?', attemptId)!.n) >= 10) throw new OrchestrationError('TOO_MANY_ARTIFACTS');
    if (args.path !== undefined && args.source_tool_call_id !== undefined) throw new OrchestrationError('INVALID_INPUT', 'Choose path OR source_tool_call_id, not both.');
    const images = this.capturedImages.get(attemptId);
    const captured = args.source_tool_call_id === undefined ? [...(images?.values() ?? [])].at(-1) : images?.get(boundedText(args.source_tool_call_id, 256));
    if (args.path === undefined && !captured) throw new OrchestrationError('MCP_IMAGE_NOT_CAPTURED', 'No captured MCP image for this attempt. Capture an image first, or supply an existing local file path.');
    let source: string;
    try { source = this.allowedPath(attemptId, generation, args.path ?? captured); }
    catch (error) {
      if (['ENOENT', 'INVALID_REQUEST'].includes(String((error as any).code))) throw new OrchestrationError('ARTIFACT_FILE_NOT_FOUND', 'The supplied path is not a saved file. For an MCP screenshot, omit path to stage its captured image, or use source_tool_call_id. Do not invent a filename.');
      throw error;
    }
    const caption = args.caption === undefined ? '' : boundedText(args.caption, 1024);
    if (statSync(source).size > 50 * 1024 * 1024) throw new OrchestrationError('ATTACHMENT_TOO_LARGE');
    const path = ingestOrchestrationMedia(this.agentsRoot, this.store.agentId, `api-${task.agentSessionId}`, source);
    const kind = detectImageMime(readFileSync(source).subarray(0, 12)) ? 'image' : 'file';
    const id = randomUUID();
    this.store.run('INSERT INTO task_files VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, task.taskId, attemptId, actionId, path, basename(source).replace(/[\r\n]/g, '_').slice(0, 200), kind, caption, null, Date.now(), payloadHash(args));
    return { artifactId: id, path, staged: true };
  }
  remember(attemptId: string, generation: number, actionId: string, args: Record<string, unknown>) {
    const { task, conversation } = this.scope(attemptId, generation);
    if (!task.capabilities.writeMemory || conversation.source === 'api') throw new OrchestrationError('MEMORY_WRITE_DENIED');
    const note = boundedText(args.note, 8192), name = args.path === undefined ? `memory/${new Date().toISOString().slice(0,10)}.md` : boundedText(args.path, 256);
    if (!/^(?:MEMORY\.md|USER\.md|memory\/[A-Za-z0-9_-]+\.md)$/.test(name)) throw new OrchestrationError('MEMORY_PATH_DENIED');
    const workspace = join(this.agentsRoot, this.store.agentId, 'workspace'), destination = join(workspace, name);
    mkdirSync(dirname(destination), { recursive: true });
    if (realpathSync(dirname(destination)) !== join(realpathSync(workspace), name.startsWith('memory/') ? 'memory' : '') || (existsSync(destination) && lstatSync(destination).isSymbolicLink())) throw new OrchestrationError('MEMORY_PATH_DENIED');
    if (existsSync(destination) && statSync(destination).size > 1048576) throw new OrchestrationError('MEMORY_TOO_LARGE');
    const old = existsSync(destination) ? readFileSync(destination, 'utf8') : '';
    const operation = createHash('sha256').update(`${attemptId}:${actionId}`).digest('hex');
    const marker = `<!-- orchestration-memory:${operation}:${createHash('sha256').update(name + '\0' + note).digest('hex')} -->`;
    if (old.includes(`<!-- orchestration-memory:${operation}:`) && !old.includes(marker)) throw new OrchestrationError('IDEMPOTENCY_CONFLICT');
    if (!old.includes(marker)) {
      const temporary = `${destination}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, `${old}\n${marker}\n${note}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, destination);
      const directory = openSync(dirname(destination), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    this.store.transaction(() => this.store.appendEvent(task.conversationId, 'task.memory_updated', { taskId: task.taskId, path: name, operation }));
    return { updated: true, path: name };
  }
}
