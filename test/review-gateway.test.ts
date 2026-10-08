import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createAgentSession, SessionManager, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { registerGateway } from "../src/gateway";
import { startBridge, type BridgeHost } from "../src/bridge";
import { available } from "../src/capabilities";
import { CAPABILITY_NAMES, type Capabilities } from "../src/protocol";
import noli from "../src/index";

const bootstrap = "review-bootstrap-not-a-live-secret";
const first = "a".repeat(43), second = "b".repeat(43);
const model = { id: "gateway-review", name: "Review", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 };
type Frame = { id: string | number; method?: string; ok?: boolean; error?: { code: string } };
class Client {
  readonly socket: Socket;
  private buffer = "";
  private queue: Frame[] = [];
  private waiters: Array<(frame: Frame) => void> = [];
  constructor(path: string) {
    this.socket = connect(path);
    this.socket.on("data", bytes => {
      this.buffer += bytes.toString();
      for (;;) {
        const end = this.buffer.indexOf("\n");
        if (end < 0) return;
        const frame = JSON.parse(this.buffer.slice(0, end)) as Frame;
        this.buffer = this.buffer.slice(end + 1);
        if (!("id" in frame)) continue;
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame); else this.queue.push(frame);
      }
    });
  }
  send(frame: object) { this.socket.write(`${JSON.stringify(frame)}\n`); }
  next(): Promise<Frame> {
    const value = this.queue.shift();
    if (value) return Promise.resolve(value);
    const { promise, resolve } = Promise.withResolvers<Frame>();
    this.waiters.push(resolve);
    return promise;
  }
  async call(frame: object) { this.send(frame); return this.next(); }
}
function host(session: () => string): BridgeHost {
  const capabilities = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, available("public", "review")])) as Capabilities;
  return { sessionId: session, capabilities: () => capabilities, refreshCapabilities: () => capabilities,
    subscribe: () => () => {}, onCapabilitiesChanged: () => () => {} } as unknown as BridgeHost;
}
async function fixture(port = 12345) {
  const dir = mkdtempSync(join(tmpdir(), "noli-review-"));
  writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: { "noli-openai": { baseUrl: `http://127.0.0.1:${port}`, api: "openai-completions", models: [model] } } }));
  const auth = await AuthStorage.create(join(dir, "agent.db"));
  const registry = new ModelRegistry(auth, join(dir, "models.yml"), { settings: Settings.isolated({ enabledModels: ["noli-*/*"] }) });
  const pi = { registerProvider: (name: string, config: Parameters<ModelRegistry["registerProvider"]>[1]) => registry.registerProvider(name, config, "review") } as ExtensionAPI;
  const gateway = registerGateway(pi, dir)!;
  return { dir, auth, registry, gateway, dispose() { auth.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("review: legacy non-gateway client can authenticate after a native session switch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noli-review-legacy-"));
  let session = "old";
  expect(registerGateway({} as ExtensionAPI, dir)).toBeUndefined();
  const bridge = startBridge({ dir, token: bootstrap, host: host(() => session) });
  const old = new Client(bridge.socketPath);
  let replacement: Client | undefined;
  try {
    expect((await old.call({ id: 1, method: "hello", params: { token: bootstrap } })).ok).toBe(true);
    session = "new";
    bridge.invalidateAuthentication();
    replacement = new Client(bridge.socketPath);
    const response = await replacement.call({ id: 2, method: "hello", params: { token: bootstrap } });
    expect(response.ok).toBe(true);
  } finally { old.socket.destroy(); replacement?.socket.destroy(); bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("review: gateway catalog keeps hello one-use even after session invalidation", async () => {
  const f = await fixture();
  let session = "old";
  const bridge = startBridge({ dir: f.dir, token: bootstrap, host: host(() => session), gateway: f.gateway });
  const original = new Client(bridge.socketPath);
  let replacement: Client | undefined;
  try {
    expect((await original.call({ id: 1, method: "hello", params: { token: bootstrap } })).ok).toBe(true);
    const request = await original.next();
    original.send({ type: "response", id: request.id, ok: true, result: { token: first, expires_ms: Date.now() + 3_600_000 } });
    expect((await original.call({ id: 2, method: "gateway.ready", sessionId: session, params: {} })).ok).toBe(true);
    session = "new";
    bridge.invalidateAuthentication();
    replacement = new Client(bridge.socketPath);
    expect((await replacement.call({ id: 3, method: "hello", params: { token: bootstrap } })).error?.code).toBe("unauthorized");
  } finally { original.socket.destroy(); replacement?.socket.destroy(); bridge.close(); f.dispose(); }
});

test("review: renewal keeps the unexpired credential usable until its replacement arrives", async () => {
  const f = await fixture();
  const existing = f.registry.find("noli-openai", model.id)!;
  const bridge = startBridge({ dir: f.dir, token: bootstrap, host: host(() => "session"), gateway: f.gateway });
  const client = new Client(bridge.socketPath);
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  // Move the next renewal timer's clock to its normal one-minute-before-expiry boundary.
  const now = realNow();
  let accelerated = false;
  const retryDelays: number[] = [];
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (!accelerated && delay !== undefined && delay > 3_000_000) {
      accelerated = true;
      return realSetTimeout(() => { Date.now = () => now + 3_540_001; if (typeof handler === "function") handler(...args); }, 1);
    }
    if (delay === 1_000 || delay === 2_000) {
      retryDelays.push(delay);
      return realSetTimeout(handler, 10, ...args);
    }
    return realSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;
  try {
    await client.call({ id: 1, method: "hello", params: { token: bootstrap } });
    const initial = await client.next();
    client.send({ type: "response", id: initial.id, ok: true, result: { token: first, expires_ms: now + 3_600_000 } });
    expect((await client.call({ id: 2, method: "gateway.ready", sessionId: "session", params: {} })).ok).toBe(true);
    const renewal = await client.next();
    expect(renewal.method).toBe("gateway.bind");
    expect(Date.now()).toBeLessThan(now + 3_600_000);
    // Main, child and background inference retain the still-valid key while renewal is pending.
    expect(await f.registry.getApiKey(existing) === "noli-pending").toBe(false);
    client.send({ type: "response", id: renewal.id, ok: false, error: { code: "not_ready" } });
    const retry = await client.next();
    expect(retry.method).toBe("gateway.bind");
    expect(await f.registry.getApiKey(existing) === first).toBe(true);
    client.send({ type: "response", id: retry.id, ok: false, error: { code: "not_ready" } });
    const secondRetry = await client.next();
    expect(retryDelays).toEqual([1_000, 2_000]);
    expect(await f.registry.getApiKey(existing) === first).toBe(true);
    client.send({ type: "response", id: secondRetry.id, ok: true, result: { token: second, expires_ms: Date.now() + 3_600_000 } });
    expect((await client.call({ id: 3, method: "gateway.ready", sessionId: "session", params: {} })).ok).toBe(true);
    expect(await f.registry.getApiKey(existing) === second).toBe(true);
  } finally { Date.now = realNow; globalThis.setTimeout = realSetTimeout; client.socket.destroy(); bridge.close(); f.dispose(); }
});

test("review: failed and timed-out renewals revoke only at actual expiry and recover", async () => {
  const f = await fixture();
  const existing = f.registry.find("noli-openai", model.id)!;
  const bridge = startBridge({ dir: f.dir, token: bootstrap, host: host(() => "session"), gateway: f.gateway });
  const client = new Client(bridge.socketPath);
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const now = realNow();
  let clock = now;
  const timers: Array<{ delay: number | undefined; run(): void }> = [];
  Date.now = () => clock;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    timers.push({ delay, run() { if (typeof handler === "function") handler(...args); } });
    return realSetTimeout(handler, 3_600_000, ...args);
  }) as typeof setTimeout;
  try {
    await client.call({ id: 1, method: "hello", params: { token: bootstrap } });
    const initial = await client.next();
    client.send({ type: "response", id: initial.id, ok: true, result: { token: first, expires_ms: now + 3_600_000 } });
    expect((await client.call({ id: 2, method: "gateway.ready", sessionId: "session", params: {} })).ok).toBe(true);
    clock = now + 3_540_000;
    timers.find(timer => timer.delay === 3_540_000)!.run();
    const renewal = await client.next();
    expect(renewal.method).toBe("gateway.bind");
    expect(await f.registry.getApiKey(existing) === first).toBe(true);
    timers.filter(timer => timer.delay === 10_000).at(-1)!.run();
    await Promise.resolve(); await Promise.resolve();
    expect(await f.registry.getApiKey(existing) === first).toBe(true);
    expect(timers.at(-1)!.delay).toBe(1_000);
    clock = now + 3_600_000;
    timers.find(timer => timer.delay === 3_600_000)!.run();
    expect(await f.registry.getApiKey(existing) === "noli-pending").toBe(true);
    timers.find(timer => timer.delay === 1_000)!.run();
    const retry = await client.next();
    // A late reply to the timed-out request cannot install a key or satisfy the retry.
    client.send({ type: "response", id: renewal.id, ok: true, result: { token: first, expires_ms: clock + 3_600_000 } });
    client.send({ type: "response", id: retry.id, ok: true, result: { token: second, expires_ms: clock + 3_600_000 } });
    const ack = await client.call({ id: 3, method: "gateway.ready", sessionId: "session", params: {} });
    // Ignore the bad_request response for the deliberately stale reverse-RPC reply.
    expect(ack.ok === true || (await client.next()).ok === true).toBe(true);
    expect(await f.registry.getApiKey(existing) === second).toBe(true);
  } finally { Date.now = realNow; globalThis.setTimeout = realSetTimeout; client.socket.destroy(); bridge.close(); f.dispose(); }
});

test("review: real SDK streaming auth retry and subsequent requests honor a re-registered key", async () => {
  const seen: string[] = [];
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    seen.push(request.headers.get("authorization") ?? "");
    if (seen.length === 1) { admitted.resolve(); await release.promise; return Response.json({ error: { message: "invalid api key", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 }); }
    return new Response('data: {"id":"review","object":"chat.completion.chunk","created":1,"model":"gateway-review","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"review","object":"chat.completion.chunk","created":1,"model":"gateway-review","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  const f = await fixture(server.port!);
  try {
    const existing = f.registry.find("noli-openai", model.id)!;
    f.gateway.bind({ token: first, expires_ms: Date.now() + 3_600_000 });
    const context = { messages: [{ role: "user" as const, content: "review", timestamp: 1 }] };
    const pending = streamSimple(existing, context, { apiKey: f.registry.resolver(existing, "session") }).result();
    await admitted.promise;
    f.gateway.bind({ token: second, expires_ms: Date.now() + 3_600_000 });
    release.resolve();
    expect((await pending).stopReason).not.toBe("error");
    expect((await streamSimple(existing, context, { apiKey: f.registry.resolver(existing, "session") }).result()).stopReason).not.toBe("error");
    expect(seen.length).toBe(3);
    expect(seen[0] === `Bearer ${first}`).toBe(true);
    expect(seen.slice(1).every(value => value === `Bearer ${second}`)).toBe(true);
  } finally { release.resolve(); server.stop(true); f.dispose(); }
}, 20_000);

test("review: real SDK factory, switch and branch rebind without environment or disk credentials", async () => {
  const f = await fixture();
  let session: AgentSession | undefined;
  let client: Client | undefined;
  const oldDir = process.env.NOLI_BRIDGE_DIR;
  const oldTokenFile = process.env.NOLI_BRIDGE_TOKEN_FILE;
  try {
    process.env.NOLI_BRIDGE_DIR = f.dir;
    const tokenFile = join(f.dir, "bootstrap-token");
    writeFileSync(tokenFile, bootstrap, { mode: 0o600 });
    process.env.NOLI_BRIDGE_TOKEN_FILE = tokenFile;
    const manager = SessionManager.create(f.dir, join(f.dir, "sessions"));
    const created = await createAgentSession({ cwd: f.dir, agentDir: join(f.dir, "agent"), sessionManager: manager,
      modelRegistry: f.registry, model: f.registry.find("noli-openai", model.id),
      settings: Settings.isolated({ "memory.backend": "off", enabledModels: ["noli-*/*"] }),
      toolNames: [], enableMCP: false, enableLsp: false, disableExtensionDiscovery: true,
      additionalExtensionPaths: [join(import.meta.dir, "../src/index.ts")], cacheWarming: false });
    session = created.session;
    expect(process.env.NOLI_BRIDGE_TOKEN_FILE).toBeUndefined();
    expect(existsSync(tokenFile)).toBe(false);
    const child = Bun.spawn([process.execPath, "-e", `process.stdout.write(Object.values(process.env).includes(${JSON.stringify(bootstrap)}) ? 'leaked' : 'clear')`], { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(child.stdout).text()).toBe("clear");
    expect(await child.exited).toBe(0);
    await initializeExtensions(session, { reportSendError: (_action, error) => { throw error; }, reportRuntimeError: error => { throw new Error(error.error); } });
    client = new Client(join(f.dir, `omp-${process.pid}.sock`));
    await client.call({ id: 1, method: "hello", params: { token: bootstrap } });
    const bind = await client.next();
    client.send({ type: "response", id: bind.id, ok: true, result: { token: first, expires_ms: Date.now() + 3_600_000 } });
    expect((await client.call({ id: 2, method: "gateway.ready", sessionId: manager.getSessionId(), params: {} })).ok).toBe(true);
    const initial = manager.getSessionId();
    expect(await session.newSession()).toBe(true);
    expect(manager.getSessionId()).not.toBe(initial);
    expect(await f.registry.getApiKey(session.model!) === "noli-pending").toBe(true);
    client.send({ id: 3, method: "session.adopt", sessionId: initial, params: { sessionId: manager.getSessionId() } });
    const switched = await client.next();
    expect(switched.method).toBe("gateway.bind");
    client.send({ type: "response", id: switched.id, ok: true, result: { token: second, expires_ms: Date.now() + 3_600_000 } });
    const switchAck = await client.next();
    expect(switchAck.ok).toBe(true);
    manager.appendMessage({ role: "user", content: "branch target", timestamp: Date.now() });
    const target = manager.getLeafId()!;
    manager.appendMessage({ role: "user", content: "after target", timestamp: Date.now() });
    const previous = manager.getSessionId();
    expect((await session.branch(target)).cancelled).toBe(false);
    expect(manager.getSessionId()).not.toBe(previous);
    expect(await f.registry.getApiKey(session.model!) === "noli-pending").toBe(true);
    client.send({ id: 4, method: "session.adopt", sessionId: previous, params: { sessionId: manager.getSessionId() } });
    const branched = await client.next();
    expect(branched.method).toBe("gateway.bind");
    client.send({ type: "response", id: branched.id, ok: true, result: { token: first, expires_ms: Date.now() + 3_600_000 } });
    const branchAck = await client.next();
    expect(branchAck.ok).toBe(true);
    expect(await f.registry.getApiKey(session.model!) === first).toBe(true);
    function scan(path: string) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (entry.isFile()) {
          const bytes = readFileSync(file);
          expect(bytes.includes(Buffer.from(first)) || bytes.includes(Buffer.from(second))).toBe(false);
        }
      }
    }
    scan(f.dir);
    await session.dispose();
    session = undefined;
    expect(await f.registry.getApiKey(f.registry.find("noli-openai", model.id)!) === "noli-pending").toBe(true);
  } finally {
    client?.socket.destroy();
    await session?.dispose();
    if (oldDir === undefined) delete process.env.NOLI_BRIDGE_DIR; else process.env.NOLI_BRIDGE_DIR = oldDir;
    if (oldTokenFile === undefined) delete process.env.NOLI_BRIDGE_TOKEN_FILE; else process.env.NOLI_BRIDGE_TOKEN_FILE = oldTokenFile;
    f.dispose();
  }
}, 30_000);

test("review: factory consumes launch bootstrap before implicitly inherited child processes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noli-review-launch-env-"));
  const tokenFile = join(dir, "bootstrap-token");
  writeFileSync(tokenFile, bootstrap, { mode: 0o600 });
  try {
    const code = `
      import { loadExtensions } from ${JSON.stringify(join(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/index.ts"))};
      import { existsSync } from "node:fs";
      const loaded = await loadExtensions([${JSON.stringify(join(import.meta.dir, "../src/index.ts"))}], ${JSON.stringify(dir)});
      if (loaded.errors.length) throw new Error("extension failed to load");
      const parentClear = process.env.NOLI_BRIDGE_TOKEN === undefined;
      const consumed = !existsSync(${JSON.stringify(tokenFile)});
      const child = Bun.spawn([process.execPath, "-e", "const fs = require('node:fs'); process.stdout.write(process.env.NOLI_BRIDGE_TOKEN === undefined && (!process.env.NOLI_BRIDGE_TOKEN_FILE || !fs.existsSync(process.env.NOLI_BRIDGE_TOKEN_FILE)) ? 'clear' : 'leaked')"], {cwd:${JSON.stringify(dir)},stdout:"pipe",stderr:"pipe"});
      console.log(JSON.stringify({parentClear, consumed, child:await new Response(child.stdout).text(), exit:await child.exited}));
    `;
    const environment: NodeJS.ProcessEnv = { ...process.env, NOLI_BRIDGE_DIR: dir, NOLI_BRIDGE_TOKEN_FILE: tokenFile };
    delete environment.NOLI_BRIDGE_TOKEN;
    const processUnderReview = Bun.spawn([process.execPath, "-e", code], {
      cwd: dir, env: environment, stdout: "pipe", stderr: "pipe"
    });
    const observed = JSON.parse(await new Response(processUnderReview.stdout).text());
    expect(await processUnderReview.exited).toBe(0);
    expect(observed.parentClear).toBe(true);
    expect(observed.consumed).toBe(true);
    expect(observed.child).toBe("clear");
    expect(observed.exit).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

test("review: bootstrap files reject symlinks and non-private permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "noli-review-bootstrap-file-"));
  const target = join(dir, "bootstrap-token");
  const link = join(dir, "bootstrap-link");
  const oldDir = process.env.NOLI_BRIDGE_DIR;
  const oldTokenFile = process.env.NOLI_BRIDGE_TOKEN_FILE;
  const pi = { on() {}, registerTool() {} } as unknown as ExtensionAPI;
  try {
    process.env.NOLI_BRIDGE_DIR = dir;
    writeFileSync(target, bootstrap, { mode: 0o600 });
    symlinkSync(target, link);
    process.env.NOLI_BRIDGE_TOKEN_FILE = link;
    expect(() => noli(pi)).toThrow();
    expect(existsSync(target)).toBe(true);
    chmodSync(target, 0o644);
    process.env.NOLI_BRIDGE_TOKEN_FILE = target;
    expect(() => noli(pi)).toThrow("Invalid Noli bootstrap file");
    expect(existsSync(target)).toBe(true);
  } finally {
    if (oldDir === undefined) delete process.env.NOLI_BRIDGE_DIR; else process.env.NOLI_BRIDGE_DIR = oldDir;
    if (oldTokenFile === undefined) delete process.env.NOLI_BRIDGE_TOKEN_FILE; else process.env.NOLI_BRIDGE_TOKEN_FILE = oldTokenFile;
    rmSync(dir, { recursive: true, force: true });
  }
});
