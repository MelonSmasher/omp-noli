import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { Socket } from "bun";

import { z } from "@oh-my-pi/pi-coding-agent";
import { assertValidFrame } from "./schema";

const responseSchema = z.object({ type: z.literal("response"), ok: z.boolean(), result: z.object({ cancelled: z.boolean().optional(), backend: z.string().optional(), count: z.number().optional(), stored: z.number().optional() }).passthrough().optional() }).passthrough();
interface NativeResponse { type: "response"; ok: boolean; result?: { cancelled?: boolean; backend?: string; count?: number; stored?: number } }
test("official extension tree event preserves authenticated same-session navigation response", async () => {
	const dir = mkdtempSync(join(tmpdir(), "noli-native-lifecycle-"));
	const oldDir = process.env.NOLI_BRIDGE_DIR;
	const oldToken = process.env.NOLI_BRIDGE_TOKEN;
	let session: AgentSession | undefined;
	let socket: Socket<undefined> | undefined;
	try {
		process.env.NOLI_BRIDGE_DIR = dir;
		process.env.NOLI_BRIDGE_TOKEN = crypto.randomUUID();
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		const created = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), sessionManager: manager, settings: Settings.isolated({ "memory.backend": "off" }), toolNames: [], enableMCP: false, enableLsp: false, disableExtensionDiscovery: true, additionalExtensionPaths: [join(import.meta.dir, "../src/index.ts")], cacheWarming: false });
		session = created.session;
		const runner = session.extensionRunner!;
		await runner.emit({ type: "session_start" });
		manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		const target = manager.getLeafId()!;
		manager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
		let buffer = "";
		const pending: Array<(frame: NativeResponse) => void> = [];
		socket = await Bun.connect({ unix: join(dir, `omp-${process.pid}.sock`), socket: { data(_socket, bytes) { buffer += bytes.toString(); for (;;) { const end = buffer.indexOf("\n"); if (end < 0) break; const parsed: unknown = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); assertValidFrame(parsed); const response = responseSchema.safeParse(parsed); if (response.success) pending.shift()?.(response.data); } } } });
		const call = (method: string, params: Record<string, unknown>) => new Promise<NativeResponse>(resolve => { pending.push(resolve); socket!.write(`${JSON.stringify({ id: pending.length, method, params, sessionId: manager.getSessionId() })}\n`); });
		expect((await call("hello", { token: process.env.NOLI_BRIDGE_TOKEN })).ok).toBe(true);
		const result = await call("tree.navigate", { targetId: target, summarize: false });
		expect(result.ok).toBe(true);
		expect(result.result?.cancelled).toBe(false);
		expect((await call("memory.status", {})).ok).toBe(true);
		const searched = await call("memory.search", { query: "real socket", limit: 1 });
		expect(searched.ok).toBe(true);
		expect(searched.result?.backend).toBe("off");
		expect(searched.result?.count).toBe(0);
		const saved = await call("memory.save", { content: "real socket" });
		expect(saved.ok).toBe(true);
		expect(saved.result?.backend).toBe("off");
		expect(saved.result?.stored).toBe(0);
	} finally {
		socket?.terminate();
		await session?.dispose();
		if (oldDir === undefined) delete process.env.NOLI_BRIDGE_DIR; else process.env.NOLI_BRIDGE_DIR = oldDir;
		if (oldToken === undefined) delete process.env.NOLI_BRIDGE_TOKEN; else process.env.NOLI_BRIDGE_TOKEN = oldToken;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
