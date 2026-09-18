import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RequestToolSchemas {
  messageId: string;
  requestId: string;
  loaded: string[];
  deferred: string[];
  source: 'cli-request-body';
}
/** Keep only tool names from the CLI's outbound request capture. Raw bodies are
 * temporary, private, never logged, and removed as soon as metadata is extracted. */
export class RequestToolCapture {
  readonly directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-tool-schemas-'));
  private pending = new Map<string, {loaded: string[]; deferred: string[]}>();
  private measured = new Map<string, RequestToolSchemas>();
  private indexes = new Map<string, string>();
  private offset = 0;
  private remainder = '';
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly emit: (value: RequestToolSchemas) => void) {
    try { fs.chmodSync(this.directory, 0o700); }
    catch (error) { try { fs.rmSync(this.directory, {recursive:true,force:true}); } catch {} throw error; }
    this.timer = setInterval(() => this.scan(), 200);
    this.timer.unref();
  }
  private read(name: string): string | undefined {
    if (!/^[A-Za-z0-9_-]+\.(request|response)\.json$|^index\.jsonl$/.test(name)) return;
    let fd: number | undefined;
    try {
      fd = fs.openSync(path.join(this.directory, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > 16 * 1024 * 1024) return;
      return fs.readFileSync(fd, 'utf8');
    } catch { return; } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  private remove(name: string): void { try { fs.unlinkSync(path.join(this.directory, name)); } catch {} }
  scan(): void {
    if (this.closed) return;
    try {
      for (const file of fs.readdirSync(this.directory)) {
        if (file.endsWith('.request.json')) {
          const raw = this.read(file); if (!raw) continue;
          try {
            const body = JSON.parse(raw);
            const names = extractToolSchemas(body);
            this.pending.set(file, names);
            if (this.pending.size > 512) this.pending.delete(this.pending.keys().next().value!);
            this.remove(file);
          } catch { /* A write may still be in progress; retry next scan. */ }
        } else if (file.endsWith('.response.json')) {
          // Do not read or retain response text. The correlation index is enough.
          this.remove(file);
        }
      }
      const raw = this.read('index.jsonl');
      if (raw === undefined) return;
      if (raw.length < this.offset) { this.offset = 0; this.remainder = ''; }
      const lines = (this.remainder + raw.slice(this.offset)).split('\n');
      this.offset = raw.length; this.remainder = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const index=JSON.parse(line);
          if(typeof index.request_file==='string'&&/^[A-Za-z0-9_-]+\.request\.json$/.test(index.request_file)&&typeof index.message_id==='string'&&index.message_id.length<=256)this.indexes.set(index.request_file,index.message_id);
        } catch {}
      }
      for(const [file,messageId] of this.indexes){
        const metadata=this.pending.get(file);if(!metadata)continue;
        const value:RequestToolSchemas={messageId,requestId:file.replace(/\.request\.json$/,''),...metadata,source:'cli-request-body'};
        this.pending.delete(file);this.indexes.delete(file);this.measured.set(messageId,value);
        if(this.measured.size>512)this.measured.delete(this.measured.keys().next().value!);
        this.emit(value);
      }
      while(this.indexes.size>512)this.indexes.delete(this.indexes.keys().next().value!);
    } catch { /* Capture may be unavailable on older CLI versions. */ }
  }
  async flush(expectedIds?: string[]): Promise<RequestToolSchemas[]> {
    // CLI writes its correlation index asynchronously after the result event.
    for (let i=0;i<5&&!this.closed;i++) { await new Promise(r=>setTimeout(r,20)); this.scan(); if(expectedIds?.every(id=>this.measured.has(id)))break; }
    return [...this.measured.values()];
  }
  close(): void {
    if (this.closed) return;
    this.scan(); this.closed = true; clearInterval(this.timer);
    try { fs.rmSync(this.directory, {recursive:true,force:true}); } catch {}
  }
}

export function extractToolSchemas(body: any): {loaded:string[];deferred:string[]} {
  const referenced = new Set<string>();
  // Deferred schemas become visible through tool references in tool-search results.
  const visit = (value: any, depth=0): void => {
    if (depth>24 || !value || typeof value!=='object') return;
    if (value.type==='tool_reference' && typeof value.tool_name==='string') referenced.add(value.tool_name);
    if (Array.isArray(value)) for (const item of value) visit(item,depth+1);
    else if (value.content) visit(value.content,depth+1);
  };
  visit(body.messages);
  const loaded = new Set<string>(), deferred = new Set<string>();
  for (const tool of Array.isArray(body.tools)?body.tools:[]) {
    if (typeof tool?.name!=='string' || !tool.name || tool.name.length>256) continue;
    (tool.defer_loading===true&&!referenced.has(tool.name)?deferred:loaded).add(tool.name);
  }
  return {loaded:[...loaded].sort(),deferred:[...deferred].sort()};
}
