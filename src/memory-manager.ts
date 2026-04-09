import * as fs from 'fs';
import * as path from 'path';
import PQueue from 'p-queue';

const MEMORY_FILE = 'MEMORY.md';
const DEFAULT_HEADER = '# Memory\n';

export class MemoryManager {
  private readonly memoryPath: string;
  private readonly queue: PQueue;

  constructor(workspaceDir: string) {
    this.memoryPath = path.join(workspaceDir, MEMORY_FILE);
    this.queue = new PQueue({ concurrency: 1 });
  }

  /**
   * Append a fact under the given section in memory.md.
   * If the section exists, the fact is appended under it.
   * If the section does not exist, it is created at the end of the file.
   */
  async appendFact(section: string, fact: string): Promise<void> {
    await this.queue.add(async () => {
      this._ensureFile();
      const content = fs.readFileSync(this.memoryPath, 'utf-8');
      const sectionHeader = `## ${section}`;
      const factLine = `- ${fact}`;

      if (content.includes(sectionHeader)) {
        // Find the section and insert after it (before the next ## or end of file)
        const lines = content.split('\n');
        const sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader);

        // Find where this section ends (next ## header or EOF)
        let insertIdx = lines.length;
        for (let i = sectionIdx + 1; i < lines.length; i++) {
          if (lines[i].startsWith('## ')) {
            // Insert before the blank line(s) preceding the next section
            insertIdx = i;
            // Back up past any trailing blank lines
            while (insertIdx > sectionIdx + 1 && lines[insertIdx - 1].trim() === '') {
              insertIdx--;
            }
            break;
          }
        }

        lines.splice(insertIdx, 0, factLine);
        const newContent = lines.join('\n');
        fs.writeFileSync(this.memoryPath, newContent, 'utf-8');
      } else {
        // Append new section at end of file
        const trimmed = content.trimEnd();
        const newContent = `${trimmed}\n\n${sectionHeader}\n${factLine}\n`;
        fs.writeFileSync(this.memoryPath, newContent, 'utf-8');
      }
    });
  }

  /**
   * Append raw markdown to memory.md.
   */
  async appendRaw(markdown: string): Promise<void> {
    await this.queue.add(async () => {
      this._ensureFile();
      fs.appendFileSync(this.memoryPath, markdown, 'utf-8');
    });
  }

  /**
   * Read the full memory.md content.
   */
  async readMemory(): Promise<string> {
    this._ensureFile();
    return fs.readFileSync(this.memoryPath, 'utf-8');
  }

  /**
   * Search memory for a keyword (simple string match, case-insensitive).
   * Returns all matching lines.
   */
  async searchMemory(query: string): Promise<string[]> {
    this._ensureFile();
    const content = fs.readFileSync(this.memoryPath, 'utf-8');
    const lowerQuery = query.toLowerCase();
    return content
      .split('\n')
      .filter((line) => line.toLowerCase().includes(lowerQuery));
  }

  /**
   * Get memory stats: file size in bytes, line count, section count.
   */
  async getStats(): Promise<{ sizeBytes: number; lineCount: number; sectionCount: number }> {
    this._ensureFile();
    const content = fs.readFileSync(this.memoryPath, 'utf-8');
    const stat = fs.statSync(this.memoryPath);
    const lines = content.split('\n');
    const sectionCount = lines.filter((l) => l.startsWith('## ')).length;
    return {
      sizeBytes: stat.size,
      lineCount: lines.length,
      sectionCount,
    };
  }

  /**
   * Trim memory.md to at most maxChars by removing oldest lines
   * (lines from the top of the file, after the first # header line).
   * Returns the number of lines removed.
   */
  async trimToSize(maxChars: number): Promise<{ removed: number }> {
    return await this.queue.add(async () => {
      this._ensureFile();
      const content = fs.readFileSync(this.memoryPath, 'utf-8');

      if (content.length <= maxChars) {
        return { removed: 0 };
      }

      const lines = content.split('\n');

      // Find the first non-header content line to start trimming from
      // We preserve the # Memory header (first line)
      let firstBodyLine = 1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() !== '' && !lines[i].startsWith('#')) {
          firstBodyLine = i;
          break;
        }
      }

      let removed = 0;
      let current = content;

      while (current.length > maxChars && firstBodyLine < lines.length - 1) {
        lines.splice(firstBodyLine, 1);
        removed++;
        current = lines.join('\n');
      }

      fs.writeFileSync(this.memoryPath, current, 'utf-8');
      return { removed };
    }) as { removed: number };
  }

  /**
   * Ensure memory.md exists with a default header.
   */
  private _ensureFile(): void {
    if (!fs.existsSync(this.memoryPath)) {
      const dir = path.dirname(this.memoryPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.memoryPath, DEFAULT_HEADER, 'utf-8');
    }
  }
}
