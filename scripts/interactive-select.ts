/**
 * Shared interactive select component for CLI wizards.
 * Uses arrow keys / j/k to navigate, Enter to confirm, Ctrl+C to cancel.
 * Renders with reverse video highlight and hides cursor during selection.
 */

export function interactiveSelect(items: string[], label: string): Promise<number> {
  return new Promise((resolve) => {
    let selected = 0;
    const { stdin, stdout } = process;

    // Pad item text to fixed width for consistent highlight bar
    const maxLen = Math.max(...items.map((s) => s.length));

    function renderItem(i: number): string {
      const text = `    ${items[i]}`.padEnd(maxLen + 6);
      if (i === selected) {
        // Reverse video — uses terminal's default colors
        return `\x1b[7m${text}\x1b[0m`;
      }
      return text;
    }

    // Total lines drawn: 1 (label) + 1 (blank) + items.length
    const totalLines = items.length + 2;

    function render(): void {
      // Move cursor up to redraw list only (not label)
      stdout.write(`\x1b[${items.length}A`);
      for (let i = 0; i < items.length; i++) {
        stdout.write(`\x1b[2K${renderItem(i)}\n`);
      }
    }

    // Hide cursor during selection
    stdout.write('\x1b[?25l');

    // Initial render: label + blank line + items
    stdout.write(`${label}\n\n`);
    for (let i = 0; i < items.length; i++) {
      stdout.write(`${renderItem(i)}\n`);
    }

    if (!stdin.isTTY) {
      resolve(0);
      return;
    }

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    function onData(key: Buffer): void {
      const s = key.toString();

      if (s === '\x1b[A' || s === 'k') {
        // Up arrow or k
        selected = (selected - 1 + items.length) % items.length;
        render();
      } else if (s === '\x1b[B' || s === 'j') {
        // Down arrow or j
        selected = (selected + 1) % items.length;
        render();
      } else if (s === '\r' || s === '\n') {
        // Enter
        cleanup();
        resolve(selected);
      } else if (s === '\x03') {
        // Ctrl+C
        cleanup();
        process.exit(0);
      }
    }

    function cleanup(): void {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      // Clear select UI (move up past all lines and clear each)
      stdout.write(`\x1b[${totalLines}A`);
      for (let i = 0; i < totalLines; i++) {
        stdout.write('\x1b[2K\n');
      }
      stdout.write(`\x1b[${totalLines}A`);
      // Restore cursor visibility
      stdout.write('\x1b[?25h');
    }

    stdin.on('data', onData);
  });
}
