import { spawn } from "node:child_process";
import pkg from "../../../package.json" with { type: "json" };
import type { McpCatalog } from "./scan.js";

/**
 * A minimal MCP client: connect, list what the server shows the model, leave.
 *
 * It never calls a tool, reads a resource or renders a prompt — listing is
 * enough to see the metadata gap, and calling anything on an untrusted
 * server would defeat the point of scanning it first.
 *
 * Both protocol eras are supported, following the spec's stdio
 * backward-compatibility rule (modelcontextprotocol.io, revision 2026-07-28):
 *   modern (2026-07-28+): no handshake; every request carries
 *     `_meta["io.modelcontextprotocol/protocolVersion"]` etc. We probe with
 *     `server/discover`.
 *   legacy (2025-11-25 and earlier): `initialize` + `notifications/initialized`.
 *     Used when the probe returns a non-modern error or no reply in time.
 *
 * Transports: stdio (newline-delimited JSON-RPC 2.0) and Streamable HTTP
 * (POST; JSON or SSE responses; legacy `Mcp-Session-Id`).
 */

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSION = "2025-11-25";
export const DEFAULT_TIMEOUT_MS = 15_000;
/** stdout / response bytes accepted from a server before giving up. */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

const CLIENT_INFO = { name: "wysiwyg", title: "wysiwyg MCP scanner", version: pkg.version };
/** How long a legacy server gets to answer (or reject) the `server/discover` probe. */
const PROBE_MS = 3000;
const MAX_PAGES = 100;
/** Error codes only modern servers emit: HeaderMismatch, MissingRequiredClientCapability, UnsupportedProtocolVersion. */
const MODERN_ERROR_CODES = new Set([-32020, -32021, -32022]);
const UNSUPPORTED_VERSION = -32022;

export interface StdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ClientOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export interface ListResult {
  catalog: McpCatalog;
  era: "modern" | "legacy";
  protocolVersion: string;
  /** Non-fatal problems: list methods that failed or were cut short. */
  notes: string[];
}

/** A failure talking to the server (spawn, timeout, protocol). */
export class McpClientError extends Error {}

/** The server answered with a JSON-RPC error. */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${message} (code ${code})`);
  }
}

class TimeoutError extends McpClientError {}

/** HTTP error status without a JSON-RPC error body (a legacy server rejecting a modern request). */
class HttpStatusError extends McpClientError {}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

interface Transport {
  request(method: string, params: Json, timeoutMs: number): Promise<Json>;
  notify(method: string, params?: Json): Promise<void>;
  /** HTTP needs to know the era for its headers; stdio ignores it. */
  setEra(era: "modern" | "legacy", version: string): void;
  /** True once the server process is gone (stdio): a fallback must reconnect. */
  readonly closed: boolean;
  close(): Promise<void>;
}

function rpcErrorFrom(msg: Json): RpcError {
  const e = isObject(msg.error) ? msg.error : {};
  return new RpcError(
    typeof e.code === "number" ? e.code : 0,
    typeof e.message === "string" ? e.message : "error",
    e.data,
  );
}

// ─── stdio ───────────────────────────────────────────────────────────

function openStdio(server: StdioServer, maxBytes: number): Transport {
  const child = spawn(server.command, server.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"], // never inherit the user's terminal
    env: { ...process.env, ...server.env },
    cwd: server.cwd,
  });
  const pending = new Map<number, { resolve: (r: Json) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let buffered = "";
  let received = 0;
  let stderrTail = "";
  let closedError: Error | undefined;
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));

  const fail = (err: Error) => {
    closedError ??= err;
    for (const p of pending.values()) p.reject(closedError);
    pending.clear();
  };
  const signal = (sig: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(sig);
  };
  const shutdown = () => {
    // EOF on stdin is the spec's graceful shutdown signal; then escalate.
    child.stdin.end();
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), 1000).unref();
  };
  const send = (msg: Json) => {
    if (!child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  };

  const handle = (line: string) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // servers that log to stdout: skip the noise
    }
    if (!isObject(msg)) return;
    if (msg.id !== undefined && msg.id !== null && ("result" in msg || "error" in msg)) {
      const p = pending.get(msg.id as number);
      if (!p) return;
      pending.delete(msg.id as number);
      if ("error" in msg) p.reject(rpcErrorFrom(msg));
      else p.resolve(isObject(msg.result) ? msg.result : {});
    } else if (typeof msg.method === "string" && msg.id !== undefined && msg.id !== null) {
      // Legacy servers may ask for roots/sampling; decline so they don't wait on us.
      send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    received += Buffer.byteLength(chunk);
    if (received > maxBytes) {
      fail(new McpClientError(`server wrote more than ${maxBytes} bytes to stdout`));
      shutdown();
      return;
    }
    buffered += chunk;
    for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line) handle(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });
  child.stdin.on("error", () => {}); // EPIPE when the server exits early
  child.on("error", (err) => fail(new McpClientError(`cannot start "${server.command}": ${err.message}`)));
  child.on("close", (code, sig) => {
    const tail = stderrTail.trim().split("\n").slice(-5).join("\n");
    fail(
      new McpClientError(
        `server exited${sig ? ` (${sig})` : ` with code ${code}`} before answering${tail ? `; stderr:\n${tail}` : ""}`,
      ),
    );
  });

  return {
    get closed() {
      return closedError !== undefined;
    },
    setEra() {},
    request(method, params, timeoutMs) {
      if (closedError) return Promise.reject(closedError);
      const id = nextId++;
      return new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new TimeoutError(`no reply to ${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        send({ id, method, params });
      });
    },
    async notify(method, params) {
      send({ method, ...(params ? { params } : {}) });
    },
    async close() {
      shutdown();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000).unref())]);
    },
  };
}

// ─── Streamable HTTP ─────────────────────────────────────────────────

async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new McpClientError(`response larger than ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Read SSE events until the response with `id` arrives (the stream may stay open after it). */
async function readSse(
  body: ReadableStream<Uint8Array>,
  id: number,
  maxBytes: number,
): Promise<Json | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        size += value.byteLength;
        if (size > maxBytes) throw new McpClientError(`response larger than ${maxBytes} bytes`);
        buffered += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      }
      const events = buffered.split("\n\n");
      buffered = done ? "" : (events.pop() ?? "");
      for (const event of events) {
        const data = event
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        try {
          const msg = JSON.parse(data);
          if (isObject(msg) && msg.id === id) return msg;
        } catch {}
      }
      if (done) return undefined;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function openHttp(url: string, headers: Record<string, string>, maxBytes: number): Transport {
  let era: "modern" | "legacy" = "modern";
  let version = MODERN_VERSION;
  let session: string | undefined;
  let nextId = 1;

  const post = async (body: Json, method: string, timeoutMs: number): Promise<Response> => {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": `wysiwyg/${pkg.version}`,
      ...headers,
    };
    if (era === "modern") {
      h["MCP-Protocol-Version"] = version;
      h["Mcp-Method"] = method;
    } else {
      if (method !== "initialize") h["MCP-Protocol-Version"] = version;
      if (session) h["Mcp-Session-Id"] = session;
    }
    try {
      return await fetch(url, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
        throw new TimeoutError(`no reply to ${method}`);
      throw new McpClientError(`${method}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    closed: false,
    setEra(e, v) {
      era = e;
      version = v;
    },
    async request(method, params, timeoutMs) {
      const id = nextId++;
      const res = await post({ id, method, params }, method, timeoutMs);
      const sid = res.headers.get("mcp-session-id");
      if (sid && era === "legacy") session = sid;
      let msg: Json | undefined;
      if (res.body && (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        msg = await readSse(res.body, id, maxBytes);
      } else if (res.body) {
        try {
          const parsed = JSON.parse(await readCapped(res.body, maxBytes));
          msg = Array.isArray(parsed) ? parsed.find((m) => isObject(m) && m.id === id) : parsed;
        } catch (err) {
          if (err instanceof McpClientError) throw err;
        }
      }
      if (isObject(msg) && "error" in msg) throw rpcErrorFrom(msg);
      if (!res.ok) throw new HttpStatusError(`${method}: HTTP ${res.status}`);
      if (!isObject(msg) || !isObject(msg.result)) throw new McpClientError(`${method}: invalid response`);
      return msg.result;
    },
    async notify(method, params) {
      const res = await post({ method, ...(params ? { params } : {}) }, method, 5000).catch(() => undefined);
      await res?.body?.cancel().catch(() => {});
    },
    async close() {
      if (!session) return;
      const h = { ...headers, "Mcp-Session-Id": session, "MCP-Protocol-Version": version };
      await fetch(url, { method: "DELETE", headers: h, signal: AbortSignal.timeout(2000) }).catch(() => {});
    },
  };
}

// ─── Session: handshake + listing ────────────────────────────────────

interface Handshake {
  era: "modern" | "legacy";
  version: string;
  capabilities?: Json;
  serverInfo?: Json;
  instructions?: unknown;
}

function meta(version: string): Json {
  return {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

const newerThanLegacy = (v: unknown): v is string => typeof v === "string" && v > LEGACY_VERSION;

function modernHandshake(result: Json, requested: string): Handshake {
  const supported = Array.isArray(result.supportedVersions) ? result.supportedVersions : [];
  const version = supported.includes(requested) ? requested : (supported.find(newerThanLegacy) ?? requested);
  const resultMeta = isObject(result._meta) ? result._meta : {};
  const serverInfo = resultMeta["io.modelcontextprotocol/serverInfo"];
  return {
    era: "modern",
    version,
    capabilities: isObject(result.capabilities) ? result.capabilities : undefined,
    serverInfo: isObject(serverInfo) ? serverInfo : undefined,
    instructions: result.instructions,
  };
}

class Deadline {
  private readonly end: number;
  constructor(readonly ms: number) {
    this.end = Date.now() + ms;
  }
  remaining(): number {
    const left = this.end - Date.now();
    if (left <= 0) throw new TimeoutError("deadline reached");
    return left;
  }
}

/** Resolve with the promise's value, or reject with ProbeTimeout after `ms` (the promise keeps running). */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeout()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

class ProbeTimeout extends Error {}

async function legacyHandshake(transport: Transport, deadline: Deadline): Promise<Json> {
  transport.setEra("legacy", LEGACY_VERSION);
  return transport.request(
    "initialize",
    { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    deadline.remaining(),
  );
}

function fromInitialize(init: Json): Handshake {
  return {
    era: "legacy",
    version: typeof init.protocolVersion === "string" ? init.protocolVersion : LEGACY_VERSION,
    capabilities: isObject(init.capabilities) ? init.capabilities : undefined,
    serverInfo: isObject(init.serverInfo) ? init.serverInfo : undefined,
    instructions: init.instructions,
  };
}

/**
 * Probe with `server/discover`. A modern answer keeps us modern; any other
 * error, or silence past the probe window, falls back to `initialize`
 * (reconnecting if the probe killed the server). A server that was merely
 * slow to start (npx downloading a package) may still answer the probe late,
 * so after a silent probe we take whichever of the two replies arrives first.
 */
async function handshake(
  open: () => Transport,
  deadline: Deadline,
): Promise<{ transport: Transport; hs: Handshake }> {
  let transport = open();
  try {
    const discover = transport.request(
      "server/discover",
      { _meta: meta(MODERN_VERSION) },
      deadline.remaining(),
    );
    discover.catch(() => {});
    let silent = false;
    try {
      const result = await within(discover, Math.min(PROBE_MS, deadline.remaining()));
      return { transport, hs: modernHandshake(result, MODERN_VERSION) };
    } catch (err) {
      if (err instanceof ProbeTimeout) silent = true;
      else if (err instanceof RpcError && MODERN_ERROR_CODES.has(err.code)) {
        const data = isObject(err.data) ? err.data : {};
        const retry = Array.isArray(data.supported) ? data.supported.find(newerThanLegacy) : undefined;
        if (err.code === UNSUPPORTED_VERSION && retry) {
          transport.setEra("modern", retry);
          const result = await transport.request(
            "server/discover",
            { _meta: meta(retry) },
            deadline.remaining(),
          );
          return { transport, hs: modernHandshake(result, retry) };
        }
        // Unsupported version with only legacy versions listed: it answers `initialize`.
        if (err.code !== UNSUPPORTED_VERSION) throw err;
      } else if (
        !(
          err instanceof RpcError ||
          err instanceof TimeoutError ||
          err instanceof HttpStatusError ||
          transport.closed
        )
      ) {
        throw err;
      }
    }

    if (transport.closed) {
      await transport.close();
      transport = open();
      silent = false;
    }
    const init = legacyHandshake(transport, deadline);
    init.catch(() => {});
    let hs: Handshake;
    if (silent) {
      try {
        hs = await Promise.any([
          discover.then((r) => modernHandshake(r, MODERN_VERSION)),
          init.then(fromInitialize),
        ]);
      } catch {
        hs = fromInitialize(await init); // both failed: surface the initialize error
      }
    } else {
      hs = fromInitialize(await init);
    }
    transport.setEra(hs.era, hs.version);
    if (hs.era === "legacy") await transport.notify("notifications/initialized");
    return { transport, hs };
  } catch (err) {
    await transport.close();
    throw err;
  }
}

/** Page through a list method (tools/list, prompts/list, …). */
async function listAll(
  transport: Transport,
  hs: Handshake,
  method: string,
  key: string,
  deadline: Deadline,
  notes: string[],
): Promise<Json[]> {
  const items: Json[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Json = hs.era === "modern" ? { _meta: meta(hs.version) } : {};
    if (cursor) params.cursor = cursor;
    let result: Json;
    try {
      result = await transport.request(method, params, deadline.remaining());
    } catch (err) {
      if (err instanceof RpcError) {
        notes.push(`${method} failed: ${err.message}`);
        return items;
      }
      throw err;
    }
    if (Array.isArray(result[key])) items.push(...result[key].filter(isObject));
    const next = result.nextCursor;
    if (typeof next !== "string" || !next || seen.has(next)) return items;
    seen.add(next);
    cursor = next;
  }
  notes.push(`${method}: stopped after ${MAX_PAGES} pages`);
  return items;
}

async function collect(open: () => Transport, opts: ClientOptions): Promise<ListResult> {
  const deadline = new Deadline(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let transport: Transport | undefined;
  try {
    const connected = await handshake(open, deadline);
    transport = connected.transport;
    const { hs } = connected;
    const caps = hs.capabilities;
    // Servers declare what they support; without a capabilities object, try everything.
    const has = (c: string) => !caps || c in caps;
    const notes: string[] = [];
    const list = (method: string, key: string) => listAll(transport!, hs, method, key, deadline, notes);

    const catalog: McpCatalog = { serverInfo: hs.serverInfo, instructions: hs.instructions };
    if (has("tools")) catalog.tools = await list("tools/list", "tools");
    if (has("prompts")) catalog.prompts = await list("prompts/list", "prompts");
    if (has("resources")) {
      catalog.resources = await list("resources/list", "resources");
      catalog.resourceTemplates = await list("resources/templates/list", "resourceTemplates");
    }
    return { catalog, era: hs.era, protocolVersion: hs.version, notes };
  } catch (err) {
    if (err instanceof TimeoutError)
      throw new McpClientError(`server did not respond within ${deadline.ms} ms (${err.message})`);
    if (err instanceof RpcError) throw new McpClientError(`server returned an error: ${err.message}`);
    throw err;
  } finally {
    await transport?.close();
  }
}

/** Spawn a stdio server, list its tools/prompts/resources, and stop it. */
export function listStdioServer(server: StdioServer, opts: ClientOptions = {}): Promise<ListResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return collect(() => openStdio(server, maxBytes), opts);
}

/** Connect to a Streamable HTTP server and list its tools/prompts/resources. */
export function listHttpServer(
  url: string,
  opts: ClientOptions & { headers?: Record<string, string> } = {},
): Promise<ListResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return collect(() => openHttp(url, opts.headers ?? {}, maxBytes), opts);
}
