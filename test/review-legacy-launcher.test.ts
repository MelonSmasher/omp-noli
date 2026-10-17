import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, Settings, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import * as zod from "@oh-my-pi/omptype/zod";
import noli from "../src/index";
import { connect, type Socket } from "node:net";
import type { HelloResult, ServerFrame } from "../src/protocol";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { installForgeRelay, releaseForgeRoot } from "../src/forge-relay";

test("review: non-gateway Noli launcher still starts the bridge using its existing bootstrap contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noli-review-legacy-launch-"));
  const oldDir = process.env.NOLI_BRIDGE_DIR;
  const oldToken = process.env.NOLI_BRIDGE_TOKEN;
  const oldFile = process.env.NOLI_BRIDGE_TOKEN_FILE;
  let session: AgentSession | undefined;
  let socket: Socket | undefined;
  try {
    // The non-gateway Noli launcher has no catalog and supplies the released v0.6.0 environment contract.
    process.env.NOLI_BRIDGE_DIR = dir;
    process.env.NOLI_BRIDGE_TOKEN = "synthetic-legacy-bootstrap";
    delete process.env.NOLI_BRIDGE_TOKEN_FILE;
    expect(existsSync(join(dir, "gateway-providers.json"))).toBe(false);
    const created = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"),
      sessionManager: SessionManager.create(dir, join(dir, "sessions")),
      settings: Settings.isolated({ "memory.backend": "off" }), toolNames: [],
      enableMCP: false, enableLsp: false, disableExtensionDiscovery: true,
      additionalExtensionPaths: [join(import.meta.dir, "../src/index.ts")], cacheWarming: false });
    session = created.session;
    expect(process.env.NOLI_BRIDGE_TOKEN).toBeUndefined();
    await initializeExtensions(session, { reportSendError: (_action, error) => { throw error; }, reportRuntimeError: error => { throw new Error(error.error); } });
    expect(existsSync(join(dir, `omp-${process.pid}.sock`))).toBe(true);
    const hello = await new Promise<ServerFrame>((resolve, reject) => {
      socket = connect(join(dir, `omp-${process.pid}.sock`));
      socket.once("error", reject);
      socket.setTimeout(5_000, () => reject(new Error("legacy hello timed out")));
      let buffer = "";
      socket.on("data", bytes => {
        buffer += bytes.toString();
        const end = buffer.indexOf("\n");
        if (end >= 0) resolve(JSON.parse(buffer.slice(0, end)) as ServerFrame);
      });
      socket.once("connect", () => socket!.write(`${JSON.stringify({ id: 1, method: "hello", params: { token: "synthetic-legacy-bootstrap" } })}\n`));
    });
    expect(hello.type).toBe("response");
    if (hello.type !== "response" || !hello.ok) throw new Error("legacy bootstrap did not authenticate");
    expect((hello.result as HelloResult).capabilities["gateway.bind"].available).toBe(false);
  } finally {
    socket?.destroy();
    await session?.dispose();
    if (oldDir === undefined) delete process.env.NOLI_BRIDGE_DIR; else process.env.NOLI_BRIDGE_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOLI_BRIDGE_TOKEN; else process.env.NOLI_BRIDGE_TOKEN = oldToken;
    if (oldFile === undefined) delete process.env.NOLI_BRIDGE_TOKEN_FILE; else process.env.NOLI_BRIDGE_TOKEN_FILE = oldFile;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("review: a gateway catalog refuses legacy environment-token bootstrap", () => {
  const dir = mkdtempSync(join(tmpdir(), "noli-review-legacy-gateway-"));
  const oldDir = process.env.NOLI_BRIDGE_DIR;
  const oldToken = process.env.NOLI_BRIDGE_TOKEN;
  const oldFile = process.env.NOLI_BRIDGE_TOKEN_FILE;
  let registrations = 0;
  try {
    process.env.NOLI_BRIDGE_DIR = dir;
    process.env.NOLI_BRIDGE_TOKEN = "synthetic-legacy-bootstrap";
    delete process.env.NOLI_BRIDGE_TOKEN_FILE;
    writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: {} }));
    const pi = { on() {}, registerTool() {}, registerProvider() { registrations++; } } as unknown as Parameters<typeof noli>[0];
    expect(() => noli(pi)).toThrow("Noli gateway binding requires NOLI_BRIDGE_TOKEN_FILE");
    expect(process.env.NOLI_BRIDGE_TOKEN).toBeUndefined();
    expect(registrations).toBe(0);
    expect(existsSync(join(dir, `omp-${process.pid}.sock`))).toBe(false);
  } finally {
    if (oldDir === undefined) delete process.env.NOLI_BRIDGE_DIR; else process.env.NOLI_BRIDGE_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOLI_BRIDGE_TOKEN; else process.env.NOLI_BRIDGE_TOKEN = oldToken;
    if (oldFile === undefined) delete process.env.NOLI_BRIDGE_TOKEN_FILE; else process.env.NOLI_BRIDGE_TOKEN_FILE = oldFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: stale root shutdown preserves the replacement bridge, host and forge root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noli-review-root-shutdown-"));
  const oldDir = process.env.NOLI_BRIDGE_DIR;
  const oldToken = process.env.NOLI_BRIDGE_TOKEN;
  const oldFile = process.env.NOLI_BRIDGE_TOKEN_FILE;
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
  const clearedStatuses: string[] = [];
  const tool = { description: "Forge status", parameters: {}, async execute() { return { content: [] }; } };
  const registry = {
    get: () => ({ session: { hasRpcHostTool: (name: string) => name === "noli_forge_status", getToolByName: () => tool } }),
    list: () => [],
    onChange: () => () => {},
  };
  const pi = {
    zod,
    pi: { AgentRegistry: { global: () => registry } },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool() {},
    getAllTools: () => [],
    logger: { warn() {} },
    events: { on: () => () => {} },
  } as unknown as ExtensionAPI;
  const oldContext = {
    agent: { kind: "main", id: "Main" },
    sessionManager: { getSessionId: () => "old-root", getSessionFile: () => undefined },
    ui: { notify() {}, setStatus() { clearedStatuses.push("old-root"); } },
  } as unknown as ExtensionContext;
  const replacement = {
    agent: { kind: "main", id: "Main" },
    sessionManager: { getSessionId: () => "replacement-root", getSessionFile: () => undefined },
    ui: { notify() {}, setStatus() { clearedStatuses.push("replacement-root"); } },
  } as unknown as ExtensionContext;
  let socket: Socket | undefined;
  try {
    process.env.NOLI_BRIDGE_DIR = dir;
    process.env.NOLI_BRIDGE_TOKEN = "synthetic-root-shutdown-bootstrap";
    delete process.env.NOLI_BRIDGE_TOKEN_FILE;
    noli(pi);
    for (const handler of handlers.get("session_start") ?? []) handler({}, oldContext);
    for (const handler of handlers.get("session_switch") ?? []) handler({}, replacement);
    for (const handler of handlers.get("session_shutdown") ?? []) handler({}, oldContext);
    expect(clearedStatuses).toEqual([]);
    expect(existsSync(join(dir, `omp-${process.pid}.sock`))).toBe(true);
    const names: string[] = [];
    installForgeRelay({ on() {}, registerTool(definition: { name: string }) { names.push(definition.name); } } as unknown as ExtensionAPI, dir);
    expect(names).toEqual(["noli_forge_status"]);
    const hello = await new Promise<ServerFrame>((resolve, reject) => {
      socket = connect(join(dir, `omp-${process.pid}.sock`));
      socket.once("error", reject);
      socket.setTimeout(5_000, () => reject(new Error("replacement hello timed out")));
      let buffer = "";
      socket.on("data", bytes => {
        buffer += bytes.toString();
        const end = buffer.indexOf("\n");
        if (end >= 0) resolve(JSON.parse(buffer.slice(0, end)) as ServerFrame);
      });
      socket.once("connect", () => socket!.write(`${JSON.stringify({ id: 1, method: "hello", params: { token: "synthetic-root-shutdown-bootstrap" } })}\n`));
    });
    expect(hello.type).toBe("response");
    if (hello.type !== "response" || !hello.ok) throw new Error("replacement bridge did not authenticate");
    expect((hello.result as HelloResult).sessionId).toBe("replacement-root");
    for (const handler of handlers.get("session_shutdown") ?? []) handler({}, replacement);
    expect(clearedStatuses).toEqual(Array(6).fill("replacement-root"));
    expect(existsSync(join(dir, `omp-${process.pid}.sock`))).toBe(false);
    names.length = 0;
    installForgeRelay({ on() {}, registerTool(definition: { name: string }) { names.push(definition.name); } } as unknown as ExtensionAPI, dir);
    expect(names).toEqual([]);
  } finally {
    socket?.destroy();
    for (const handler of handlers.get("session_shutdown") ?? []) handler({}, replacement);
    releaseForgeRoot(dir);
    if (oldDir === undefined) delete process.env.NOLI_BRIDGE_DIR; else process.env.NOLI_BRIDGE_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOLI_BRIDGE_TOKEN; else process.env.NOLI_BRIDGE_TOKEN = oldToken;
    if (oldFile === undefined) delete process.env.NOLI_BRIDGE_TOKEN_FILE; else process.env.NOLI_BRIDGE_TOKEN_FILE = oldFile;
    rmSync(dir, { recursive: true, force: true });
  }
});
