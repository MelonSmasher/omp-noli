import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { endpointAddress } from "./endpoint";
import { assertValidFrame } from "./schema";
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
import { CAPABILITY_NAMES, type Capabilities, type ProducerSessionParams, type RequestFacts } from "../src/protocol";
import noli from "../src/index";

const bootstrap = "review-bootstrap-not-a-live-secret";
const first = "a".repeat(43), second = "b".repeat(43);
const model = { id: "gateway-review", name: "Review", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 };
type Frame = { id: string | number; method?: string; params?: Record<string, unknown> & { ompSessionId?: string; facts?: RequestFacts | null }; ok?: boolean; error?: { code: string }; result?: { bound?: boolean; renewalError?: string; capabilities?: Capabilities } };

class Client {
  readonly socket: Socket;
  private buffer = "";
  private queue: Frame[] = [];
  private waiters: Array<(frame: Frame) => void> = [];
  constructor(path: string) {
    this.socket = connect(endpointAddress(path));
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

test("review: bind reply and same-session adoption share one installation and cancellable timer", async () => {
  const f = await fixture();
  const bridge = startBridge({ dir: f.dir, token: bootstrap, host: host(() => "session"), gateway: f.gateway });
  const client = new Client(bridge.socketPath);
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realNow = Date.now;
  const now = realNow();
  const timers = new Map<NodeJS.Timeout | number, number | undefined>();
  Date.now = () => now;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const timer = realSetTimeout(handler, delay, ...args);
    timers.set(timer, delay);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: NodeJS.Timeout | number | undefined) => {
    if (timer) timers.delete(timer);
    realClearTimeout(timer);
  }) as typeof clearTimeout;
  try {
    await client.call({ id: 1, method: "hello", params: { token: bootstrap } });
    const initial = await client.next();
    // One write forces the bridge's synchronous frame loop to see adoption before promise installation.
    client.socket.write([
      { type: "response", id: initial.id, ok: true, result: { token: first, expires_ms: now + 3_600_000 } },
      { id: 2, method: "session.adopt", sessionId: "session", params: { sessionId: "session" } },
    ].map(frame => JSON.stringify(frame)).join("\n") + "\n");
    const adoption = await client.next();
    expect(adoption.method).toBeUndefined();
    expect(adoption.ok).toBe(true);
    expect([...timers.values()].filter(delay => delay === 3_540_000)).toHaveLength(1);
    expect([...timers.values()].filter(delay => delay === 3_600_000)).toHaveLength(1);
    bridge.invalidateAuthentication();
    expect(timers.size).toBe(0);
  } finally {
    client.socket.destroy(); bridge.close(); f.dispose();
    globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; Date.now = realNow;
  }
});
function host(session: () => string): BridgeHost {
  const capabilities = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, available("public", "review")])) as Capabilities;
  return { sessionId: session, capabilities: () => capabilities, refreshCapabilities: () => capabilities,
    subscribe: () => () => {}, onCapabilitiesChanged: () => () => {} } as unknown as BridgeHost;
}
async function fixture(port = 12345, api = "openai-completions") {
  const dir = mkdtempSync(join(tmpdir(), "noli-review-"));
  writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: { "noli-openai": { baseUrl: `http://127.0.0.1:${port}`, api, models: [model] } } }));
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
    expect((await client.call({ id: 10, method: "gateway.ready", sessionId: "session", params: {} })).ok).toBe(true);
    client.send({ type: "response", id: renewal.id, ok: false, error: { code: "not_ready" } });
    const retry = await client.next();
    expect(retry.method).toBe("gateway.bind");
    expect(await f.registry.getApiKey(existing) === first).toBe(true);
    const degraded = await client.call({ id: 11, method: "gateway.ready", sessionId: "session", params: {} });
    expect(degraded.ok).toBe(true);
    expect(degraded.result?.renewalError).toBe("Noli gateway binding failed; retrying");
    client.send({ type: "response", id: retry.id, ok: false, error: { code: "not_ready" } });
    const secondRetry = await client.next();
    expect(retryDelays).toEqual([1_000, 2_000]);
    expect(await f.registry.getApiKey(existing) === first).toBe(true);
    client.send({ type: "response", id: secondRetry.id, ok: true, result: { token: second, expires_ms: Date.now() + 3_600_000 } });
    const recovered = await client.call({ id: 3, method: "gateway.ready", sessionId: "session", params: {} });
    expect(recovered.ok).toBe(true);
    expect(recovered.result?.renewalError).toBeUndefined();
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
    expect((await client.call({ id: 12, method: "gateway.ready", sessionId: "session", params: {} })).error?.code).toBe("not_ready");
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

test("review: long-lived keys wait for absolute deadlines beyond the timer limit", async () => {
  const f = await fixture();
  const existing = f.registry.find("noli-openai", model.id)!;
  const bridge = startBridge({ dir: f.dir, token: bootstrap, host: host(() => "session"), gateway: f.gateway });
  const client = new Client(bridge.socketPath);
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const now = realNow();
  let clock = now;
  const lifetime = 30 * 24 * 60 * 60 * 1_000;
  const maximum = 2_147_483_647;
  const timers: Array<{ delay: number | undefined; run(): void }> = [];
  Date.now = () => clock;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    timers.push({ delay, run() { if (typeof handler === "function") handler(...args); } });
    return realSetTimeout(() => {}, maximum);
  }) as unknown as typeof setTimeout;
  try {
    await client.call({ id: 1, method: "hello", params: { token: bootstrap } });
    const initial = await client.next();
    client.send({ type: "response", id: initial.id, ok: true, result: { token: first, expires_ms: now + lifetime } });
    expect((await client.call({ id: 2, method: "gateway.ready", sessionId: "session", params: {} })).ok).toBe(true);
    const [renewal, expiry] = timers.filter(timer => timer.delay === maximum);
    expect(timers.every(timer => timer.delay! <= maximum)).toBe(true);
    clock = now + maximum;
    renewal!.run(); expiry!.run();
    expect(await f.registry.getApiKey(existing) === first).toBe(true);
    expect((await client.call({ id: 3, method: "gateway.ready", sessionId: "session", params: {} })).ok).toBe(true);
    const remainingRenewal = timers.at(-2)!;
    const remainingExpiry = timers.at(-1)!;
    expect(remainingRenewal.delay).toBe(lifetime - 60_000 - maximum);
    expect(remainingExpiry.delay).toBe(lifetime - maximum);
    clock = now + lifetime - 60_000;
    remainingRenewal.run();
    expect((await client.next()).method).toBe("gateway.bind");
    clock = now + lifetime;
    remainingExpiry.run();
    expect(await f.registry.getApiKey(existing) === "noli-pending").toBe(true);
    expect((await client.call({ id: 4, method: "gateway.ready", sessionId: "session", params: {} })).error?.code).toBe("not_ready");
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
    const replayed: string[] = [];
    client.send({ id: 2, method: "gateway.ready", sessionId: manager.getSessionId(), params: {} });
    expect((await acknowledged(client, replayed)).ok).toBe(true);
    // The root announced itself at session_start, before Noli connected; hello replays it.
    expect(replayed).toContain(`producer.session:${manager.getSessionId()}`);
    const initial = manager.getSessionId();
    expect(await session.newSession()).toBe(true);
    expect(manager.getSessionId()).not.toBe(initial);
    expect(await f.registry.getApiKey(session.model!) === "noli-pending").toBe(true);
    client.send({ id: 3, method: "session.adopt", sessionId: initial, params: { sessionId: manager.getSessionId() } });
    const switched = await acknowledged(client, replayed);
    expect(replayed).toContain(`producer.session:${manager.getSessionId()}`);
    expect(switched.method).toBe("gateway.bind");
    client.send({ type: "response", id: switched.id, ok: true, result: { token: second, expires_ms: Date.now() + 3_600_000 } });
    const switchAck = await acknowledged(client);
    expect(switchAck.ok).toBe(true);
    manager.appendMessage({ role: "user", content: "branch target", timestamp: Date.now() });
    const target = manager.getLeafId()!;
    manager.appendMessage({ role: "user", content: "after target", timestamp: Date.now() });
    const previous = manager.getSessionId();
    expect((await session.branch(target)).cancelled).toBe(false);
    expect(manager.getSessionId()).not.toBe(previous);
    expect(await f.registry.getApiKey(session.model!) === "noli-pending").toBe(true);
    client.send({ id: 4, method: "session.adopt", sessionId: previous, params: { sessionId: manager.getSessionId() } });
    const branched = await acknowledged(client, replayed);
    expect(replayed).toContain(`producer.session:${manager.getSessionId()}`);
    expect(branched.method).toBe("gateway.bind");
    client.send({ type: "response", id: branched.id, ok: true, result: { token: first, expires_ms: Date.now() + 3_600_000 } });
    const branchAck = await acknowledged(client);
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
    // Windows grants file symlinks only to elevated or developer-mode users; the link case needs one.
    const linked = (() => {
      try { symlinkSync(target, link); return true; }
      catch (error) { if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") return false; throw error; }
    })();
    if (linked) {
      process.env.NOLI_BRIDGE_TOKEN_FILE = link;
      expect(() => noli(pi)).toThrow();
      expect(existsSync(target)).toBe(true);
    }
    // Shared with others: group/other mode bits on Unix, a grant to Everyone on Windows.
    if (process.platform === "win32") expect(Bun.spawnSync(["icacls", target, "/grant", "*S-1-1-0:(R)"]).exitCode).toBe(0);
    else chmodSync(target, 0o644);
    process.env.NOLI_BRIDGE_TOKEN_FILE = target;
    expect(() => noli(pi)).toThrow("Invalid Noli bootstrap file");
    expect(existsSync(target)).toBe(true);
  } finally {
    if (oldDir === undefined) delete process.env.NOLI_BRIDGE_DIR; else process.env.NOLI_BRIDGE_DIR = oldDir;
    if (oldTokenFile === undefined) delete process.env.NOLI_BRIDGE_TOKEN_FILE; else process.env.NOLI_BRIDGE_TOKEN_FILE = oldTokenFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Synthetic producer facts; no Claude Code process, profile or provider is used.
function requestFacts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return { version: 2, producerSessionId: "private-root", producerAgentId: "Main", parentProducerSessionId: null,
    branchAnchor: null, historyRevision: 1, requestClass: "main", querySource: "agent",
    firstEligible: { messageId: "message-1", textBlockIndex: null, sample: "abc" },
    prompt: { id: "prompt-1", origin: "human", position: { promptIndex: 1, turnIndex: 1 } }, ...overrides };
}
const rootSession: ProducerSessionParams = { ompSessionId: "private-root", parentOmpSessionId: null, agentKind: "main", agentId: "Main", epochEntryId: "epoch-root", ompVersion: "18.13.2", systemPrefix: { sha256: "2e52cff0ad7fa9912ebbeb49bb277f061719ac664f95a3a741b74e180e29a5ba", len: 752 } };
const childSession: ProducerSessionParams = { ...rootSession, ompSessionId: "private-child", parentOmpSessionId: "private-root", agentKind: "sub", agentId: "0-Task", epochEntryId: null };
const childFacts = () => requestFacts({ producerSessionId: "private-child", producerAgentId: "0-Task", parentProducerSessionId: "private-root", requestClass: "subagent", querySource: "task" });

/** Acknowledge every schema-valid producer notification until the next frame that is not one. */
async function acknowledged(client: Client, methods: string[] = []): Promise<Frame> {
  for (;;) {
    const frame = await client.next();
    if (frame.method !== "producer.session" && frame.method !== "producer.branch") return frame;
    assertValidFrame(frame);
    methods.push(`${frame.method}:${frame.params?.ompSessionId}`);
    client.send({ type: "response", id: frame.id, ok: true, result: {} });
  }
}

async function authenticatedGateway() {
  const f = await fixture();
  let session = "private-root";
  const bridge = startBridge({ dir: f.dir, token: bootstrap, host: host(() => session), gateway: f.gateway });
  // Recorded before Noli connects; replayed after hello.
  bridge.producer.announce(rootSession);
  bridge.producer.announce(childSession);
  const client = new Client(bridge.socketPath);
  await client.call({ id: 1, method: "hello", params: { token: bootstrap } });
  const bind = await client.next();
  expect(bind.method).toBe("gateway.bind");
  const replayed: string[] = [];
  client.send({ type: "response", id: bind.id, ok: true, result: { token: first, expires_ms: Date.now() + 3_600_000 } });
  client.send({ id: 2, method: "gateway.ready", sessionId: session });
  expect((await acknowledged(client, replayed)).ok).toBe(true);
  return { ...f, bridge, client, replayed, adopt() { session = "replacement-root"; bridge.invalidateAuthentication(); },
    close() { client.socket.destroy(); bridge.close(); f.dispose(); } };
}

test("review: producer identities replay root-first after hello and registrations correlate independently", async () => {
  const f = await authenticatedGateway();
  try {
    expect(f.replayed).toEqual(["producer.session:private-root", "producer.session:private-child"]);
    const main = f.bridge.producer.register("private-root", requestFacts());
    const sub = f.bridge.producer.register("private-child", childFacts());
    const one = await f.client.next(), two = await f.client.next();
    expect(one.method).toBe("gateway.request.register");
    expect(one.params).toEqual({ ompSessionId: "private-root", facts: requestFacts() });
    expect(two.params).toEqual({ ompSessionId: "private-child", facts: childFacts() });
    expect(two.id).not.toBe(one.id);
    f.client.send({ type: "response", id: two.id, ok: true, result: { requestReference: "y".repeat(43) } });
    f.client.send({ type: "response", id: one.id, ok: true, result: { requestReference: "x".repeat(43) } });
    expect(await main).toBe("x".repeat(43));
    expect(await sub).toBe("y".repeat(43));
  } finally { f.close(); }
});

test.each(["abort", "adoption", "disconnect", "malformed reply", "rejected reply"])("review: pending registration fails closed on %s", async action => {
  const f = await authenticatedGateway();
  const controller = new AbortController();
  try {
    const pending = f.bridge.producer.register("private-root", requestFacts(), controller.signal).catch(error => error);
    const frame = await f.client.next();
    if (action === "abort") controller.abort(new Error("synthetic cancellation"));
    else if (action === "adoption") f.adopt();
    else if (action === "disconnect") f.client.socket.destroy();
    else f.client.send({ type: "response", id: frame.id, ok: action !== "rejected reply", result: { requestReference: "bad" }, error: { code: "not_ready" } });
    expect(await pending).toBeInstanceOf(Error);
    if (action === "abort") {
      // A late reply cannot satisfy a new registration or leak the old waiter's slot.
      const replacement = f.bridge.producer.register("private-root", requestFacts());
      const next = await f.client.next();
      f.client.send({ type: "response", id: frame.id, ok: true, result: { requestReference: "z".repeat(43) } });
      f.client.send({ type: "response", id: next.id, ok: true, result: { requestReference: "r".repeat(43) } });
      expect(await replacement).toBe("r".repeat(43));
    }
  } finally { f.close(); }
});

test("review: producer waiters are bounded and abort releases every slot", async () => {
  const f = await authenticatedGateway();
  const controller = new AbortController();
  try {
    const pending = Array.from({ length: 64 }, () => f.bridge.producer.register("private-root", requestFacts(), controller.signal).catch(error => error));
    for (let i = 0; i < 64; i++) await f.client.next();
    await expect(f.bridge.producer.register("private-root", requestFacts())).rejects.toThrow("Too many");
    controller.abort(new Error("synthetic cancellation"));
    expect((await Promise.all(pending)).every(error => error instanceof Error)).toBe(true);
    const next = f.bridge.producer.register("private-root", requestFacts());
    const frame = await f.client.next();
    f.client.send({ type: "response", id: frame.id, ok: true, result: { requestReference: "r".repeat(43) } });
    expect(await next).toBe("r".repeat(43));
  } finally { f.close(); }
});

test("review: same-session renewal keeps an admitted registration; replacement adoption revokes it and replays only its own lineage", async () => {
  const f = await authenticatedGateway();
  try {
    const pending = f.bridge.producer.register("private-root", requestFacts());
    const request = await f.client.next();
    f.client.send({ id: 10, method: "session.adopt", params: { sessionId: "private-root" } });
    const renewal = await acknowledged(f.client);
    expect(renewal.method).toBe("gateway.bind");
    f.client.send({ type: "response", id: renewal.id, ok: true, result: { token: second, expires_ms: Date.now() + 3_600_000 } });
    expect((await f.client.next()).ok).toBe(true);
    f.client.send({ type: "response", id: request.id, ok: true, result: { requestReference: "r".repeat(43) } });
    expect(await pending).toBe("r".repeat(43));
    const stale = f.bridge.producer.register("private-root", requestFacts()).catch(error => error);
    await f.client.next();
    f.adopt();
    expect(await stale).toBeInstanceOf(Error);
    const replacement = { ...rootSession, ompSessionId: "replacement-root" };
    f.bridge.producer.forget("private-root");
    f.bridge.producer.announce(replacement);
    f.client.send({ id: 11, method: "session.adopt", params: { sessionId: "replacement-root" } });
    const replayed: string[] = [];
    const rebound = await acknowledged(f.client, replayed);
    // The old root's child names a parent Noli no longer binds; it is not replayed.
    expect(replayed).toEqual(["producer.session:replacement-root"]);
    f.client.send({ type: "response", id: rebound.id, ok: true, result: { token: first, expires_ms: Date.now() + 3_600_000 } });
    expect((await f.client.next()).ok).toBe(true);
    const fresh = f.bridge.producer.register("replacement-root", requestFacts({ producerSessionId: "replacement-root" }));
    const current = await f.client.next();
    expect(current.params?.ompSessionId).toBe("replacement-root");
    f.client.send({ type: "response", id: current.id, ok: true, result: { requestReference: "n".repeat(43) } });
    expect(await fresh).toBe("n".repeat(43));
  } finally { f.close(); }
});

test("review: registration timeout releases its waiter without accepting a late reply", async () => {
  const f = await authenticatedGateway();
  const realSetTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => realSetTimeout(handler, delay === 10_000 ? 1 : delay, ...args)) as typeof setTimeout;
    await expect(f.bridge.producer.register("private-root", requestFacts())).rejects.toThrow("timed out");
    globalThis.setTimeout = realSetTimeout;
    const old = await f.client.next();
    const pending = f.bridge.producer.register("private-root", requestFacts());
    const current = await f.client.next();
    f.client.send({ type: "response", id: old.id, ok: true, result: { requestReference: "o".repeat(43) } });
    f.client.send({ type: "response", id: current.id, ok: true, result: { requestReference: "n".repeat(43) } });
    expect(await pending).toBe("n".repeat(43));
  } finally { globalThis.setTimeout = realSetTimeout; f.close(); }
});

test("review: the private boundary rejects unsupported producer frames before sending them", async () => {
  const f = await authenticatedGateway();
  try {
    const legacy = { ...requestFacts(), firstEligible: { messageId: null, textBlockIndex: null, fingerprint: "abc" } };
    for (const facts of [undefined, { ...requestFacts(), version: 1 }, { ...requestFacts(), producerSessionId: "x".repeat(513) },
      { ...requestFacts(), historyRevision: -1 }, { ...requestFacts(), unrecognized: true }, legacy,
      { ...requestFacts(), ownership: { conversationId: "minted-by-noli" } }, { ...requestFacts(), requestClass: "compaction" },
      { ...requestFacts(), firstEligible: { messageId: null, textBlockIndex: null, sample: "ab" } },
      { ...requestFacts(), prompt: { id: null, origin: null, position: { promptIndex: 2, turnIndex: 1 } } },
      { ...requestFacts(), previousMessageId: "resp_not_anthropic" }, { ...requestFacts(), producerSessionId: "private-child" },
      { ...requestFacts(), compactionKind: "manual" }, { ...requestFacts(), contextCompacted: "later" }]) {
      await expect(f.bridge.producer.register("private-root", facts as RequestFacts)).rejects.toThrow();
    }
    await expect(f.bridge.producer.register("unannounced", requestFacts({ producerSessionId: "unannounced" }))).rejects.toThrow("unannounced");
    expect(() => f.bridge.producer.announce({ ...childSession, parentOmpSessionId: null })).toThrow();
    expect(() => f.bridge.producer.announce({ ...rootSession, systemPrefix: { sha256: "A".repeat(64), len: 1 } })).toThrow();
    await expect(f.bridge.producer.compaction({ ompSessionId: "private-root", phase: "end", facts: requestFacts({ requestClass: "compaction", compactionKind: "manual" }) })).rejects.toThrow();
    await expect(f.bridge.producer.compaction({ ompSessionId: "private-root", phase: "begin", facts: requestFacts() })).rejects.toThrow();
    // Every compaction is a native fork with its kind.
    await expect(f.bridge.producer.compaction({ ompSessionId: "private-root", phase: "begin", facts: requestFacts({ requestClass: "compaction", querySource: "compaction" }) })).rejects.toThrow();
    await expect(f.bridge.producer.branch({ ompSessionId: "private-root", leafId: null, resetEntryIds: ["\n"] })).rejects.toThrow();
    const pending = f.bridge.producer.register("private-root", requestFacts({ firstEligible: null, prompt: { id: null, origin: null, position: null } }));
    const frame = await f.client.next();
    expect(frame.params?.facts?.firstEligible).toBeNull();
    expect(frame.params?.facts?.prompt.position).toBeNull();
    f.client.send({ type: "response", id: frame.id, ok: true, result: { requestReference: "r".repeat(43) } });
    expect(await pending).toBe("r".repeat(43));
  } finally { f.close(); }
});

test("review: compaction brackets and branch resets wait for Noli's acknowledgement", async () => {
  const f = await authenticatedGateway();
  try {
    const facts = requestFacts({ requestClass: "compaction", querySource: "compaction", compactionKind: "reactive" });
    const begin = f.bridge.producer.compaction({ ompSessionId: "private-root", phase: "begin", facts });
    const opened = await f.client.next();
    expect(opened).toMatchObject({ method: "producer.compaction", params: { ompSessionId: "private-root", phase: "begin", facts } });
    f.client.send({ type: "response", id: opened.id, ok: true, result: {} });
    await begin;
    const end = f.bridge.producer.compaction({ ompSessionId: "private-root", phase: "end", facts: null });
    const closed = await f.client.next();
    expect(closed.params).toEqual({ ompSessionId: "private-root", phase: "end", facts: null });
    f.client.send({ type: "response", id: closed.id, ok: false, error: { code: "bad_request", message: "synthetic" } });
    await expect(end).rejects.toThrow("rejected");
    const branch = f.bridge.producer.branch({ ompSessionId: "private-child", leafId: "leaf", resetEntryIds: ["reset-1"] });
    const reset = await f.client.next();
    expect(reset).toMatchObject({ method: "producer.branch", params: { ompSessionId: "private-child", leafId: "leaf", resetEntryIds: ["reset-1"] } });
    f.client.send({ type: "response", id: reset.id, ok: true, result: {} });
    await branch;
    // A re-authenticated Noli receives the recorded branch with its producer.
    f.client.send({ id: 12, method: "session.adopt", params: { sessionId: "private-root" } });
    const replayed: string[] = [];
    const renewal = await acknowledged(f.client, replayed);
    expect(replayed).toEqual(["producer.session:private-root", "producer.session:private-child", "producer.branch:private-child"]);
    f.client.send({ type: "response", id: renewal.id, ok: true, result: { token: second, expires_ms: Date.now() + 3_600_000 } });
    expect((await f.client.next()).ok).toBe(true);
  } finally { f.close(); }
});
