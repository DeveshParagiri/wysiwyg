/**
 * Write to stdout and wait until the data is handed to the OS.
 *
 * console.log on a pipe is asynchronous; if the process ends first, output
 * past the pipe buffer (64 KB) is lost — JSON/SARIF consumers in CI then get
 * a truncated document.
 */
export function writeOut(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`, (err) => (err ? reject(err) : resolve()));
  });
}
