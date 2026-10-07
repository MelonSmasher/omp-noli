import { describe, expect, test } from "bun:test";
import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { RecallOptions, RecallResponse } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { nativeCapabilities, nativeControl } from "../src/native-controls";
import { CAPABILITY_NAMES } from "../src/protocol";

function fixture() {
	const calls: unknown[] = [];
	const session = { isBusyForSnapshot: false, isSessionTransitioning: false, hasAdmittedSubmission: false, isDisposed: false, queuedMessageCount: 0, hasPendingAsyncWork: () => false, navigateTree: async (...args: unknown[]) => { calls.push(args); return { cancelled: true }; }, getGoalModeState: () => ({ goal: { id: "goal" } }), goalRuntime: { onBudgetMutated: async (budget: unknown) => { calls.push(budget); return { goal: { id: "goal", tokenBudget: budget } }; } } } as unknown as AgentSession;
	const ctx = { memory: { status: async () => ({ backend: "off", active: false, searchable: false, writable: false }), search: async (...args: unknown[]) => { calls.push(args); return { backend: "mnemopi", query: args[0], count: 0, items: [] }; }, save: async (input: unknown) => { calls.push(input); return { stored: 0 }; } } } as unknown as ExtensionContext;
	return { ctx, session, calls };
}
function hindsightFixture() {
	const base = fixture();
	const recalled: unknown[] = [];
	const state = { client: { recall: async (bank: string, query: string, options: RecallOptions): Promise<RecallResponse> => {
		recalled.push([bank, query, options]);
		return { results: [{ id: "one", text: "first", type: "world", mentioned_at: "2026-10-05", score: 0.7 }, { text: "second" }] };
	} }, bankId: "configured-bank", recallTags: ["project:owned"], recallTagsMatch: "all_strict", config: { scoping: "per-project-tagged", recallBudget: "high", recallMaxTokens: 731, recallTypes: ["world"] } } as unknown as HindsightSessionState;
	let current: HindsightSessionState | undefined = state;
	Object.assign(base.session, { getHindsightSessionState: () => current });
	Object.assign(base.ctx.memory!, { status: async () => ({ backend: "hindsight", active: true, searchable: false, writable: false, message: "No structured status" }) });
	return { ...base, state, recalled, replace: (next: HindsightSessionState | undefined) => { current = next; } };
}
describe("supplemental public native APIs", () => {
	test("only real exported control methods are capabilities", () => {
		const { ctx, session } = fixture();
		expect(nativeCapabilities(ctx, session)["tree.navigate"].available).toBe(true);
		expect(nativeCapabilities(undefined, undefined)["memory.status"].available).toBe(false);
		expect(CAPABILITY_NAMES as readonly string[]).not.toContain("plan.propose");
		expect(CAPABILITY_NAMES as readonly string[]).not.toContain("memory.clear");
	});
	test("navigation forwards exact target and cancellation, without branching", async () => {
		const { ctx, session, calls } = fixture();
		expect(await nativeControl("tree.navigate", { targetId: "entry", summarize: false }, ctx, session)).toEqual({ cancelled: true });
		expect(calls).toEqual([["entry", { summarize: false }]]);
		Object.defineProperty(session, "isBusyForSnapshot", { value: true });
		await expect(nativeControl("tree.navigate", { targetId: "entry" }, ctx, session)).rejects.toThrow("active work");
	});
	test("budget null clears and unsafe values never reach native runtime", async () => {
		const { ctx, session, calls } = fixture();
		await nativeControl("goal.budget", { tokenBudget: null }, ctx, session);
		expect(calls).toEqual([undefined]);
		for (const tokenBudget of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined, "10"]) await expect(nativeControl("goal.budget", { tokenBudget }, ctx, session)).rejects.toThrow("safe integer");
		expect(calls).toHaveLength(1);
	});
	test("native admission refuses transitions, admitted prompts, queues and background work", async () => {
		for (const flag of ["isSessionTransitioning", "hasAdmittedSubmission", "isDisposed", "queuedMessageCount"]) {
			const { ctx, session, calls } = fixture();
			Object.defineProperty(session, flag, { value: flag === "queuedMessageCount" ? 1 : true });
			for (const method of ["tree.navigate", "goal.budget"] as const) await expect(nativeControl(method, method === "tree.navigate" ? { targetId: "e" } : { tokenBudget: 10 }, ctx, session)).rejects.toThrow("active work");
			expect(calls).toHaveLength(0);
		}
	});
	test("disappearing native goal cannot receive a success acknowledgement", async () => {
		const { ctx, session } = fixture();
		Object.defineProperty(session.goalRuntime, "onBudgetMutated", { value: async () => undefined });
		await expect(nativeControl("goal.budget", { tokenBudget: 10 }, ctx, session)).rejects.toThrow("goal changed");
	});
	test("navigation strips transcript cache while preserving native editor recall", async () => {
		const { ctx, session } = fixture();
		const image = { type: "image", data: "base64", mimeType: "image/png" };
		Object.defineProperty(session, "navigateTree", { value: async () => ({ cancelled: false, editorText: "recall", editorImages: [image], sessionContext: { messages: ["x".repeat(2 * 1024 * 1024)] } }) });
		expect(await nativeControl("tree.navigate", { targetId: "e" }, ctx, session)).toEqual({ cancelled: false, editorText: "recall", editorImages: [image] });
	});
	test("backend disabled and zero stored results remain truthful", async () => {
		const { ctx, session } = fixture();
		expect(await nativeControl("memory.status", {}, ctx, session)).toEqual({ backend: "off", active: false, searchable: false, writable: false });
		for (const method of ["memory.search", "memory.save"] as const) {
			expect(nativeCapabilities(ctx, session)[method].available).toBe(false);
			await expect(nativeControl(method, method === "memory.search" ? { query: "q" } : { content: "note" }, ctx, session)).rejects.toMatchObject({ body: { code: "capability_unavailable" } });
		}
		await expect(nativeControl("memory.search", { query: "q", limit: 0 }, ctx, session)).rejects.toThrow("limit");
		await expect(nativeControl("memory.save", { content: "note", importance: Infinity }, ctx, session)).rejects.toThrow("finite");
		await expect(nativeControl("memory.status", { confirmed: true }, ctx, session)).rejects.toThrow("Unknown");
	});
	test("Hindsight searches the configured native client with exact bank, tags and recall tuning", async () => {
		const { ctx, session, recalled, calls } = hindsightFixture();
		expect(await nativeControl("memory.status", {}, ctx, session)).toMatchObject({ backend: "hindsight", active: true, searchable: true, writable: false, recallBanks: ["configured-bank"] });
		expect(nativeCapabilities(ctx, session)["memory.search"].available).toBe(true);
		expect(nativeCapabilities(ctx, session)["memory.save"].available).toBe(false);
		expect(await nativeControl("memory.search", { query: "original query", limit: 1 }, ctx, session)).toEqual({ backend: "hindsight", query: "original query", count: 1, items: [{ id: "one", content: "first", source: "world", timestamp: "2026-10-05", score: 0.7 }] });
		expect(recalled).toEqual([["configured-bank", "original query", { budget: "high", maxTokens: 731, types: ["world"], tags: ["project:owned"], tagsMatch: "all_strict" }]]);
		expect(calls).toHaveLength(0);
		expect(await nativeControl("memory.search", { query: "q" }, ctx, session)).toMatchObject({ count: 2 });
		for (const limit of [0, -1, 1.5, 1001, "2", null]) await expect(nativeControl("memory.search", { query: "q", limit }, ctx, session)).rejects.toThrow("limit");
		expect(recalled).toHaveLength(2);
	});
	test("empty native recall types omit the type filter and no limit returns every native item", async () => {
		const { ctx, session, state, recalled } = hindsightFixture();
		state.config.recallTypes = [];
		expect(await nativeControl("memory.search", { query: "all" }, ctx, session)).toMatchObject({ count: 2 });
		expect(recalled).toEqual([["configured-bank", "all", { budget: "high", maxTokens: 731, types: undefined, tags: ["project:owned"], tagsMatch: "all_strict" }]]);
	});
	test("Hindsight absent state or missing recall never claims search", async () => {
		for (const missing of ["state", "recall"]) {
			const { ctx, session, state, replace, recalled } = hindsightFixture();
			if (missing === "state") replace(undefined);
			else Object.assign(state.client, { recall: undefined });
			expect(await nativeControl("memory.status", {}, ctx, session)).toMatchObject({ searchable: false, writable: false, active: missing !== "state" });
			expect(nativeCapabilities(ctx, session)["memory.search"].available).toBe(false);
			await expect(nativeControl("memory.search", { query: "q" }, ctx, session)).rejects.toThrow("does not support search");
			expect(recalled).toHaveLength(0);
		}
	});
	test("Hindsight native failures and malformed results are errors, not empty successes", async () => {
		const { ctx, session, state } = hindsightFixture();
		Object.assign(state.client, { recall: async () => { throw new Error("server body must not escape"); } });
		await expect(nativeControl("memory.search", { query: "q" }, ctx, session)).rejects.toThrow("Native Hindsight recall failed");
		for (const response of [{}, { results: [{ text: null }] }, { results: null }]) {
			Object.assign(state.client, { recall: async () => response });
			await expect(nativeControl("memory.search", { query: "q" }, ctx, session)).rejects.toThrow("invalid recall results");
		}
		Object.assign(state.client, { recall: async () => ({ results: [] }) });
		expect(await nativeControl("memory.search", { query: "empty" }, ctx, session)).toEqual({ backend: "hindsight", query: "empty", count: 0, items: [] });
	});
	test("in-place Hindsight scoping changes reject previous-scope results without an identity or revision change", async () => {
		const { ctx, session, state } = hindsightFixture();
		const config = state.config;
		config.scoping = "global";
		const identity = { getSessionId: () => "same-session", getCwd: () => "/same-project" };
		Object.assign(session, { sessionManager: identity, settings: { revision: 0 } });
		const revision = session.settings.revision;
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<RecallResponse>();
		Object.assign(state.client, { recall: async () => { entered.resolve(); return gate.promise; } });
		const result = nativeControl("memory.search", { query: "q" }, ctx, session);
		await entered.promise;
		config.scoping = "per-project-tagged";
		expect(state.config).toBe(config);
		expect(session.getHindsightSessionState()).toBe(state);
		expect(session.sessionManager === identity).toBe(true);
		expect(session.settings.revision).toBe(revision);
		gate.resolve({ results: [{ text: "previous-scope result must not escape" }] });
		await expect(result).rejects.toMatchObject({ body: { code: "stale_session" } });
	});
	test("in-place Hindsight scoping changes during native status reject search before recall", async () => {
		const { ctx, session, state, recalled } = hindsightFixture();
		const config = state.config;
		config.scoping = "global";
		const identity = { getSessionId: () => "same-session", getCwd: () => "/same-project" };
		Object.assign(session, { sessionManager: identity, settings: { revision: 0 } });
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		Object.assign(ctx.memory!, { status: async () => {
			entered.resolve();
			await gate.promise;
			return { backend: "hindsight", active: true, searchable: false, writable: false };
		} });
		const result = nativeControl("memory.search", { query: "q" }, ctx, session);
		await entered.promise;
		config.scoping = "per-project-tagged";
		expect(state.config).toBe(config);
		expect(session.getHindsightSessionState()).toBe(state);
		expect(session.sessionManager === identity).toBe(true);
		expect(session.settings.revision).toBe(0);
		gate.resolve();
		await expect(result).rejects.toMatchObject({ body: { code: "stale_session" } });
		expect(recalled).toHaveLength(0);
	});
	test("Hindsight replaced state, in-place scope changes and disposal invalidate in-flight recall", async () => {
		for (const change of ["state", "bank", "tags", "disposed", "session", "cwd", "revision", "config", "types", "stateSession", "alias"]) {
			const { ctx, session, state, replace } = hindsightFixture();
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<RecallResponse>();
			let id = "original", cwd = "/original", revision = 0;
			Object.assign(session, { sessionManager: { getSessionId: () => id, getCwd: () => cwd }, settings: { get revision() { return revision; } } });
			Object.assign(state.client, { recall: async () => { entered.resolve(); return gate.promise; } });
			const result = nativeControl("memory.search", { query: "q" }, ctx, session);
			await entered.promise;
			if (change === "state") replace({ ...state } as HindsightSessionState);
			if (change === "bank") state.bankId = "foreign";
			if (change === "tags") state.recallTags!.push("foreign");
			if (change === "disposed") Object.assign(session, { isDisposed: true });
			if (change === "session") id = "replacement";
			if (change === "cwd") cwd = "/replacement";
			if (change === "revision") revision++;
			if (change === "config") state.config.recallMaxTokens++;
			if (change === "types") state.config.recallTypes.push("experience");
			if (change === "stateSession") state.sessionId = "changed";
			if (change === "alias") state.aliasOf = { ...state } as HindsightSessionState;
			gate.resolve({ results: [] });
			await expect(result).rejects.toMatchObject({ body: { code: "stale_session" } });
		}
	});
	test("native supported backends delegate, local save preserves zero storage and unsupported search rejects", async () => {
		const { ctx, session, calls } = fixture();
		Object.assign(ctx.memory!, { status: async () => ({ backend: "mnemopi", active: true, searchable: true, writable: true }) });
		expect(await nativeControl("memory.search", { query: "q", limit: 7 }, ctx, session)).toEqual({ backend: "mnemopi", query: "q", count: 0, items: [] });
		expect(calls).toEqual([["q", { limit: 7 }]]);
		Object.assign(ctx.memory!, { status: async () => ({ backend: "local", active: true, searchable: false, writable: true }) });
		expect(await nativeControl("memory.save", { content: "note", importance: 0 }, ctx, session)).toEqual({ stored: 0 });
		expect(calls[1]).toEqual({ content: "note", context: undefined, source: undefined, importance: 0 });
		await expect(nativeControl("memory.search", { query: "q" }, ctx, session)).rejects.toThrow("does not support search");
		expect(nativeCapabilities(ctx, session)["memory.search"].available).toBe(false);
		expect(nativeCapabilities(ctx, session)["memory.save"].available).toBe(true);
	});
	test("unknown method availability allows first status discovery, but missing status APIs fail closed", async () => {
		const { ctx, session } = fixture();
		expect(nativeCapabilities(ctx, session)["memory.search"].available).toBe(true);
		expect(nativeCapabilities(ctx, session)["memory.save"].available).toBe(true);
		Object.assign(ctx.memory!, { status: undefined });
		expect(nativeCapabilities(ctx, session)["memory.search"].available).toBe(false);
		expect(nativeCapabilities(ctx, session)["memory.save"].available).toBe(false);
		await expect(nativeControl("memory.status", {}, ctx, session)).rejects.toMatchObject({ body: { code: "capability_unavailable" } });
	});
	test("status transitions and revision changes reject stale results and invalidate cached capability denial", async () => {
		const { ctx, session } = fixture();
		let revision = 0;
		Object.assign(session, { settings: { get revision() { return revision; } } });
		await nativeControl("memory.status", {}, ctx, session);
		expect(nativeCapabilities(ctx, session)["memory.search"].available).toBe(false);
		revision++;
		expect(nativeCapabilities(ctx, session)["memory.search"].available).toBe(true);
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		Object.assign(ctx.memory!, { status: async () => { entered.resolve(); await gate.promise; return { backend: "mnemopi", active: true, searchable: true, writable: true }; } });
		const pending = nativeControl("memory.status", {}, ctx, session);
		await entered.promise;
		Object.assign(session, { isSessionTransitioning: true });
		gate.resolve();
		await expect(pending).rejects.toMatchObject({ body: { code: "stale_session" } });
	});
	test("other backend capability flags and callable operations are both required", async () => {
		for (const inactive of [true, false]) {
			const { ctx, session, calls } = fixture();
			Object.assign(ctx.memory!, { status: async () => ({ backend: "mnemopi", active: !inactive, searchable: true, writable: true }), ...(inactive ? {} : { search: undefined, save: undefined }) });
			expect(await nativeControl("memory.status", {}, ctx, session)).toMatchObject({ searchable: false, writable: false });
			await expect(nativeControl("memory.search", { query: "q" }, ctx, session)).rejects.toThrow("does not support search");
			await expect(nativeControl("memory.save", { content: "q" }, ctx, session)).rejects.toThrow("does not support save");
			expect(calls).toHaveLength(0);
		}
	});
	test("other backend search and save reject ownership changes after native execution", async () => {
		for (const method of ["memory.search", "memory.save"] as const) {
			const { ctx, session } = fixture();
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			let cwd = "/old";
			Object.assign(session, { sessionManager: { getSessionId: () => "root", getCwd: () => cwd } });
			Object.assign(ctx.memory!, { status: async () => ({ backend: "mnemopi", active: true, searchable: true, writable: true }), [method === "memory.search" ? "search" : "save"]: async () => { entered.resolve(); await gate.promise; return method === "memory.search" ? { backend: "mnemopi", query: "q", count: 0, items: [] } : { backend: "mnemopi", stored: 1 }; } });
			const pending = nativeControl(method, method === "memory.search" ? { query: "q" } : { content: "q" }, ctx, session);
			await entered.promise;
			cwd = "/new";
			gate.resolve();
			await expect(pending).rejects.toMatchObject({ body: { code: "stale_session" } });
		}
	});
});
