import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createAgentSession, SessionManager, Settings, VERSION } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Server } from "bun";
import { nativeControl } from "../src/native-controls";

assert.equal(VERSION, "18.6.1");
const dir = mkdtempSync(join(tmpdir(), "noli-native-smoke-"));
let session: AgentSession | undefined;
let server: Server<undefined> | undefined;
// Keep an operator's environment-selected production backend out of this smoke.
const hindsightEnv = Object.entries(process.env).filter(([key]) => key.startsWith("HINDSIGHT_"));
for (const [key] of hindsightEnv) delete process.env[key];
try {
	const manager = SessionManager.create(dir, join(dir, "sessions"));
	const created = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), sessionManager: manager, settings: Settings.isolated({ "memory.backend": "off" }), toolNames: [], restrictToolNames: true, enableMCP: false, enableLsp: false, disableExtensionDiscovery: true, cacheWarming: false });
	session = created.session;
	const runtime = session.extensionRunner;
	assert(runtime, "official session extension runner");
	const ctx = runtime.createContext() as ExtensionContext;
	manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
	const target = manager.getLeafId()!;
	manager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
	const identity = manager.getSessionId();
	const navigation = await nativeControl("tree.navigate", { targetId: target, summarize: false }, ctx, session) as { cancelled: boolean };
	assert.equal(navigation.cancelled, false);
	assert.equal(manager.getSessionId(), identity);
	assert.notEqual(manager.getLeafId(), target, "user navigation lands on parent for editor recall");
	await session.goalRuntime.createGoal({ objective: "Native smoke objective", tokenBudget: 100 });
	await nativeControl("goal.budget", { tokenBudget: 200 }, ctx, session);
	assert.equal(session.getGoalModeState()?.goal.tokenBudget, 200);
	assert(manager.getEntries().some(entry => entry.type === "mode_change" && (entry.data?.goal as { tokenBudget?: number } | undefined)?.tokenBudget === 200), "budget persisted in native mode history");
	await nativeControl("goal.budget", { tokenBudget: null }, ctx, session);
	assert.equal(session.getGoalModeState()?.goal.tokenBudget, undefined);
	const status = await nativeControl("memory.status", {}, ctx, session) as { backend: string; active: boolean; searchable: boolean; writable: boolean };
	assert.equal(status.backend, "off");
	assert.equal(status.active, false);
	assert.equal(status.searchable, false);
	assert.equal(status.writable, false);
	await assert.rejects(nativeControl("memory.search", { query: "native smoke", limit: 1 }, ctx, session), /does not support search/);
	await assert.rejects(nativeControl("memory.save", { content: "native smoke" }, ctx, session), /does not support save/);
	await session.dispose();
	const local = await createAgentSession({ cwd: dir, agentDir: join(dir, "local-agent"), sessionManager: SessionManager.create(dir, join(dir, "local-sessions")), settings: Settings.isolated({ "memory.backend": "local" }), toolNames: [], restrictToolNames: true, enableMCP: false, enableLsp: false, disableExtensionDiscovery: true, cacheWarming: false });
	session = local.session;
	assert(session.extensionRunner);
	const localCtx = session.extensionRunner.createContext();
	const localStatus = await nativeControl("memory.status", {}, localCtx, session) as { active: boolean; writable: boolean; searchable: boolean };
	assert.equal(localStatus.active, true);
	assert.equal(localStatus.writable, true);
	assert.equal(localStatus.searchable, false);
	await assert.rejects(nativeControl("memory.search", { query: "local" }, localCtx, session), /does not support search/);
	const retained = await nativeControl("memory.save", { content: "noli-native-persistence-proof" }, localCtx, session) as { stored: number };
	assert.equal(retained.stored, 1);
	const memoryRoot = join(dir, "local-agent", "memories");
	const learned = readdirSync(memoryRoot, { recursive: true }).find(path => String(path).endsWith("learned.md"));
	assert(learned, "native lesson file exists");
	assert(readFileSync(join(memoryRoot, String(learned)), "utf8").includes("noli-native-persistence-proof"));
	await session.dispose();
	const token = randomUUID();
	const bank = "noli-native-auth-bank";
	const requests: { path: string; authenticated: boolean; body: Record<string, unknown> }[] = [];
	server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const path = new URL(request.url).pathname;
		const authenticated = request.headers.get("authorization") === `Bearer ${token}`;
		if (!authenticated) return Response.json({ detail: "authentication required" }, { status: 401 });
		if (request.method !== "POST" || path !== `/v1/default/banks/${bank}/memories/recall`) return Response.json({ detail: "wrong endpoint or bank" }, { status: 404 });
		const body = await request.json() as Record<string, unknown>;
		requests.push({ path, authenticated, body });
		if (body.query === "failure") return Response.json({ detail: "intentional native failure" }, { status: 503 });
		return Response.json({ results: [{ id: "native-one", text: "authenticated scoped memory", type: "experience", mentioned_at: "2026-10-05" }, { id: "native-two", text: "second result" }] });
	} });
	// OMP disables memory startup entirely for restrictToolNames sessions.
	// Its enabled-autolearn path awaits native backend startup; no prompt/stop
	// occurs here, so this guarantees initialization without running a capture.
	const hindsight = await createAgentSession({ cwd: dir, agentDir: join(dir, "hindsight-agent"), sessionManager: SessionManager.create(dir, join(dir, "hindsight-sessions")), settings: Settings.isolated({
		"memory.backend": "hindsight", "autolearn.enabled": true, "hindsight.apiUrl": `http://127.0.0.1:${server.port}`, "hindsight.apiToken": token,
		"hindsight.bankId": "auth-bank", "hindsight.bankIdPrefix": "noli-native", "hindsight.scoping": "per-project-tagged",
		"hindsight.recallBudget": "high", "hindsight.recallMaxTokens": 731, "hindsight.recallTypes": ["experience"],
		"hindsight.autoRecall": false, "hindsight.autoRetain": false, "hindsight.mentalModelsEnabled": false,
	}), toolNames: [], enableMCP: false, enableLsp: false, disableExtensionDiscovery: true, cacheWarming: false });
	session = hindsight.session;
	assert(session.extensionRunner);
	const hindsightCtx = session.extensionRunner.createContext();
	const nativeState = session.getHindsightSessionState();
	assert(nativeState, "configured Hindsight state initialized by official SDK");
	assert.equal(nativeState.bankId, bank);
	assert.deepEqual(nativeState.recallTags, [`project:${basename(dir).toLowerCase()}`]);
	const hindsightStatus = await nativeControl("memory.status", {}, hindsightCtx, session) as { active: boolean; searchable: boolean; writable: boolean; recallBanks: string[] };
	assert.equal(hindsightStatus.active, true);
	assert.equal(hindsightStatus.searchable, true);
	assert.equal(hindsightStatus.writable, false);
	assert.deepEqual(hindsightStatus.recallBanks, [bank]);
	const found = await nativeControl("memory.search", { query: "native scoped search", limit: 1 }, hindsightCtx, session);
	assert.deepEqual(found, { backend: "hindsight", query: "native scoped search", count: 1, items: [{ id: "native-one", content: "authenticated scoped memory", source: "experience", timestamp: "2026-10-05" }] });
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.authenticated, true, "OMP-configured native client sent bearer auth");
	assert.equal(requests[0]!.path, `/v1/default/banks/${bank}/memories/recall`);
	assert.deepEqual(requests[0]!.body, { query: "native scoped search", budget: "high", max_tokens: 731, types: ["experience"], tags: nativeState.recallTags, tags_match: nativeState.recallTagsMatch });
	await assert.rejects(nativeControl("memory.search", { query: "failure" }, hindsightCtx, session), /Native Hindsight recall failed/);
	await assert.rejects(nativeControl("memory.save", { content: "not a supported native save" }, hindsightCtx, session), /does not support save/);
	console.log("OFFICIAL NATIVE SMOKE PASSED: tree identity/leaf, persisted goal budget/clear, off/local capability gating, persisted local save, authenticated loopback Hindsight native-client search with configured bank/project tags and recall tuning; no model prompts");
} finally {
	await session?.dispose();
	server?.stop(true);
	for (const [key, value] of hindsightEnv) process.env[key] = value;
	rmSync(dir, { recursive: true, force: true });
}
