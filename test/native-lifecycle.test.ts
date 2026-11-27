import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { Socket } from "bun";

import { z } from "@oh-my-pi/pi-coding-agent";
import { assertValidFrame } from "./schema";
import { endpointAddress } from "./endpoint";

const responseSchema = z.object({ id: z.number(), type: z.literal("response"), ok: z.boolean(), result: z.object({ cancelled: z.boolean().optional(), backend: z.string().optional(), count: z.number().optional(), stored: z.number().optional(), settled: z.boolean().optional(), pendingAsyncWork: z.boolean().optional() }).passthrough().optional(), error: z.object({ code: z.string() }).passthrough().optional() }).passthrough();
interface NativeResponse { id: number; type: "response"; ok: boolean; result?: { cancelled?: boolean; backend?: string; count?: number; stored?: number; settled?: boolean; pendingAsyncWork?: boolean }; error?: { code: string } }
test("official extension preserves native pending-work admission, cancellation drain and same-session navigation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "noli-native-lifecycle-"));
	const oldDir = process.env.NOLI_BRIDGE_DIR;
	const oldTokenFile = process.env.NOLI_BRIDGE_TOKEN_FILE;
	let session: AgentSession | undefined;
	let socket: Socket<undefined> | undefined;
	try {
		process.env.NOLI_BRIDGE_DIR = dir;
        const bootstrap = crypto.randomUUID();
		const tokenFile = join(dir, "bootstrap-token");
		writeFileSync(tokenFile, bootstrap, { mode: 0o600 });
		process.env.NOLI_BRIDGE_TOKEN_FILE = tokenFile;
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		const created = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), sessionManager: manager, settings: Settings.isolated({ "memory.backend": "off" }), toolNames: [], enableMCP: false, enableLsp: false, disableExtensionDiscovery: true, additionalExtensionPaths: [join(import.meta.dir, "../src/index.ts")], cacheWarming: "off" });
		session = created.session;
		const runner = session.extensionRunner!;
		await runner.emit({ type: "session_start" });
		manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		const target = manager.getLeafId()!;
		manager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
		let buffer = "";
		const pending = new Map<number, (frame: NativeResponse) => void>();
		let sequence = 0;
		socket = await Bun.connect({ unix: endpointAddress(join(dir, `omp-${process.pid}.sock`)), socket: { data(_socket, bytes) { buffer += bytes.toString(); for (;;) { const end = buffer.indexOf("\n"); if (end < 0) break; const parsed: unknown = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); assertValidFrame(parsed); const response = responseSchema.safeParse(parsed); if (response.success) pending.get(response.data.id)?.(response.data); } } } });
		const call = (method: string, params: Record<string, unknown>) => {
			const response = Promise.withResolvers<NativeResponse>();
			const id = ++sequence;
			pending.set(id, frame => { pending.delete(id); response.resolve(frame); });
			socket!.write(`${JSON.stringify({ id, method, params, sessionId: manager.getSessionId() })}\n`);
			return response.promise;
		};
		expect(process.env.NOLI_BRIDGE_TOKEN_FILE).toBeUndefined();
		expect(existsSync(tokenFile)).toBe(false);
        expect((await call("hello", { token: bootstrap })).ok).toBe(true);
		await session.goalRuntime.createGoal({ objective: "Native pending admission regression", tokenBudget: 100 });
		const jobs = session.asyncJobManager;
		if (!jobs) throw new Error("Official OMP session has no async job manager");
		const ownerId = session.getAgentId();
		if (!ownerId) throw new Error("Official OMP session has no agent identity");
		const entered = Promise.withResolvers<void>();
		const cleanup = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const id = jobs.register("bash", "native pending admission", async ({ signal }) => {
			try {
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				entered.resolve();
				await aborted.promise;
				return "cancelled";
			} finally { cleanup.resolve(); await release.promise; }
		}, { ownerId });
		try {
			await entered.promise;
			expect(session.isRunActive).toBe(false);
			expect(session.wakeSources?.jobs).toContain(id);
			expect((await call("work.get", {})).result).toMatchObject({ settled: false, pendingAsyncWork: true });
			for (const [method, params] of [["tree.navigate", { targetId: target }], ["goal.budget", { tokenBudget: 200 }]] as const) {
				const blocked = await call(method, params);
				expect(blocked.ok).toBe(false);
				expect(blocked.error?.code).toBe("busy");
			}
			const cancelling = call("work.cancel", { jobId: id });
			await cleanup.promise;
			// Native cancellation removes its wake source before the body finally drains.
			expect(session.wakeSources).toBeUndefined();
			expect((await call("work.get", {})).result).toMatchObject({ settled: false, pendingAsyncWork: true });
			expect((await call("goal.budget", { tokenBudget: 200 })).ok).toBe(false);
			expect(session.getGoalModeState()?.goal.tokenBudget).toBe(100);
			release.resolve();
			expect((await cancelling).result?.cancelled).toBe(true);
			expect((await call("work.get", {})).result).toMatchObject({ settled: true, pendingAsyncWork: false });
			expect((await call("goal.budget", { tokenBudget: 200 })).ok).toBe(true);
		} finally {
			release.resolve();
			jobs.cancel(id, { ownerId });
			await jobs.getJob(id)?.promise;
		}
		const result = await call("tree.navigate", { targetId: target, summarize: false });
		expect(result.ok).toBe(true);
		expect(result.result?.cancelled).toBe(false);
		expect((await call("memory.status", {})).ok).toBe(true);
		const searched = await call("memory.search", { query: "real socket", limit: 1 });
		expect(searched.ok).toBe(false);
		expect(searched.error?.code).toBe("capability_unavailable");
		expect(searched.result).toBeUndefined();
		const saved = await call("memory.save", { content: "real socket" });
		expect(saved.ok).toBe(false);
		expect(saved.error?.code).toBe("capability_unavailable");
		expect(saved.result).toBeUndefined();
	} finally {
		socket?.terminate();
		await session?.dispose();
		if (oldDir === undefined) delete process.env.NOLI_BRIDGE_DIR; else process.env.NOLI_BRIDGE_DIR = oldDir;
		if (oldTokenFile === undefined) delete process.env.NOLI_BRIDGE_TOKEN_FILE; else process.env.NOLI_BRIDGE_TOKEN_FILE = oldTokenFile;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
