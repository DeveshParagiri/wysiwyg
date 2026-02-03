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

async function readMacOSClipboard(): Promise<ClipboardContent> {
  // Read plain text
  const plainProc = Bun.spawnSync(["pbpaste"]);
  const plainText = plainProc.stdout.toString().trim();

  // Read HTML format
  let html: string | null = null;
  try {
    const htmlProc = Bun.spawnSync([
      "osascript",
      "-e",
      'the clipboard as «class HTML»',
    ]);
    const output = htmlProc.stdout.toString().trim();

    // Parse the hex output: «data HTML...»
    const hexMatch = /«data HTML(.+?)»/.exec(output);
    if (hexMatch) {
      const hex = hexMatch[1];
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
      }
      html = new TextDecoder().decode(bytes);
    }
  } catch {
    // HTML clipboard format not available
  }

  return { plainText, html };
}

async function readLinuxClipboard(): Promise<ClipboardContent> {
  // Try xclip first for HTML
  let html: string | null = null;
  let plainText = "";

  try {
    const htmlProc = Bun.spawnSync([
      "xclip",
      "-selection",
      "clipboard",
      "-t",
      "text/html",
      "-o",
    ]);
    if (htmlProc.exitCode === 0) {
      html = htmlProc.stdout.toString().trim();
    }

    const plainProc = Bun.spawnSync([
      "xclip",
      "-selection",
      "clipboard",
      "-o",
    ]);
    plainText = plainProc.stdout.toString().trim();
  } catch {
    // xclip not available, try xsel
    try {
      const plainProc = Bun.spawnSync([
        "xsel",
        "--clipboard",
        "--output",
      ]);
      plainText = plainProc.stdout.toString().trim();
    } catch {
      throw new Error(
        "Neither xclip nor xsel found. Install one of them to read clipboard.",
      );
    }
  }

  return { plainText, html };
}
