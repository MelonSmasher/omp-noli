import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import noli from "../src/index";
import { connect, type Socket } from "node:net";
import { endpointAddress } from "./endpoint";
import type { HelloResult, ServerFrame } from "../src/protocol";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { installForgeRelay, releaseForgeRoot } from "../src/forge-relay";


test.each([false, true])("review: stale root shutdown preserves replacement bridge during gateway preparation=%s", async managed => {
  const dir = mkdtempSync(join(tmpdir(), "noli-review-root-shutdown-"));
  const oldDir = process.env.NOLI_BRIDGE_DIR;
  const oldToken = process.env.NOLI_BRIDGE_TOKEN;
  const oldFile = process.env.NOLI_BRIDGE_TOKEN_FILE;
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void | Promise<void>>>();
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
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool() {},
    getAllTools: () => [],
    logger: { warn() {} },
    events: { on: () => () => {} },
  } as unknown as ExtensionAPI;
  const modelRegistry = { resolver() {}, getProviderModels: () => [] };
  const oldContext = {
    agent: { kind: "main", id: "Main" },
    sessionManager: { getSessionId: () => "old-root", getSessionFile: () => undefined, getBranch: () => [], getLeafId: () => null },
    modelRegistry,
    ui: { notify() {}, setStatus() { clearedStatuses.push("old-root"); } },
  } as unknown as ExtensionContext;
  const replacement = {
    agent: { kind: "main", id: "Main" },
    sessionManager: { getSessionId: () => "replacement-root", getSessionFile: () => undefined, getBranch: () => [], getLeafId: () => null },
    modelRegistry,
    ui: { notify() {}, setStatus() { clearedStatuses.push("replacement-root"); } },
  } as unknown as ExtensionContext;
  let socket: Socket | undefined;
  try {
    process.env.NOLI_BRIDGE_DIR = dir;
    const token = join(dir, "bootstrap");
    writeFileSync(token, "synthetic-root-shutdown-bootstrap", { mode: 0o600 });
    if (managed) writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: {} }));
    process.env.NOLI_BRIDGE_TOKEN_FILE = token;
    delete process.env.NOLI_BRIDGE_TOKEN;
    noli(pi);
    const starting = (handlers.get("session_start") ?? []).map(handler => handler({}, oldContext));
    const switching = (handlers.get("session_switch") ?? []).map(handler => handler({}, replacement));
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, oldContext);
    await Promise.all([...starting, ...switching]);
    expect(clearedStatuses).toEqual([]);
    expect(existsSync(join(dir, `omp-${process.pid}.sock`))).toBe(true);
    const names: string[] = [];
    installForgeRelay({ on() {}, registerTool(definition: { name: string }) { names.push(definition.name); } } as unknown as ExtensionAPI, dir);
    expect(names).toEqual(["noli_forge_status"]);
    const hello = await new Promise<ServerFrame>((resolve, reject) => {
      socket = connect(endpointAddress(join(dir, `omp-${process.pid}.sock`)));
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
