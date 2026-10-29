import { run } from "./run.js";

/**
 * OS-specific clipboard reading.
 * Returns both plain text and rich HTML content from the system clipboard.
 */
export interface ClipboardContent {
  plainText: string;
  html: string | null;
}

/**
 * Read rich HTML and plain text from the system clipboard.
 * macOS: uses osascript
 * Linux: uses xclip or xsel
 */
export async function readClipboardHTML(): Promise<ClipboardContent> {
  const platform = process.platform;

  if (platform === "darwin") {
    return readMacOSClipboard();
  } else if (platform === "linux") {
    return readLinuxClipboard();
  }

  throw new Error(`Clipboard reading not supported on ${platform}`);
}

// Clipboard text is never trimmed: String.prototype.trim() also strips U+FEFF,
// one of the characters this tool looks for.

async function readMacOSClipboard(): Promise<ClipboardContent> {
  const plainText = run("pbpaste", []).stdout;

  // The HTML flavour comes back from AppleScript as hex: «data HTML…»
  let html: string | null = null;
  const output = run("osascript", ["-e", "the clipboard as «class HTML»"]).stdout;
  const hex = /«data HTML([0-9A-Fa-f]+)»/.exec(output)?.[1];
  if (hex) html = Buffer.from(hex, "hex").toString("utf-8");

  return { plainText, html };
}

async function readLinuxClipboard(): Promise<ClipboardContent> {
  const xclip = run("xclip", ["-selection", "clipboard", "-o"]);
  if (xclip.status === 0) {
    const htmlProc = run("xclip", ["-selection", "clipboard", "-t", "text/html", "-o"]);
    return { plainText: xclip.stdout, html: htmlProc.status === 0 ? htmlProc.stdout : null };
  }
  const xsel = run("xsel", ["--clipboard", "--output"]);
  if (xsel.status === 0) return { plainText: xsel.stdout, html: null };
  throw new Error("Neither xclip nor xsel is available. Install one of them to read the clipboard.");
}
