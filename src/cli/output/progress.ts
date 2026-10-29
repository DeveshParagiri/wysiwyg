import pc from "picocolors";

/**
 * A single transient status line on stderr ("Scanning 1,234 / 3,554 files").
 * Only drawn on an interactive terminal; cleared before results print, so it
 * never mixes with output or lands in logs.
 */
export class Progress {
  private readonly enabled = Boolean(process.stderr.isTTY) && !process.env.CI;
  private last = 0;
  private drawn = false;

  update(text: string, force = false): void {
    if (!this.enabled) return;
    const now = Date.now();
    if (!force && now - this.last < 80) return;
    this.last = now;
    process.stderr.write(`\r\x1b[2K${pc.dim(text)}`);
    this.drawn = true;
  }

  clear(): void {
    if (this.drawn) process.stderr.write("\r\x1b[2K");
    this.drawn = false;
  }
}

export const fmtCount = (n: number) => n.toLocaleString("en-US");
