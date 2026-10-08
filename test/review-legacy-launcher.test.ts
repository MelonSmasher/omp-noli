import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, Settings, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import noli from "../src/index";

test("review: non-gateway Noli launcher still starts the bridge using its existing bootstrap contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noli-review-legacy-launch-"));
  const oldDir = process.env.NOLI_BRIDGE_DIR;
  const oldToken = process.env.NOLI_BRIDGE_TOKEN;
  const oldFile = process.env.NOLI_BRIDGE_TOKEN_FILE;
  let session: AgentSession | undefined;
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
  } finally {
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
