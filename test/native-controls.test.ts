import { describe, expect, test } from "bun:test";
import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { nativeCapabilities, nativeControl } from "../src/native-controls";
import { CAPABILITY_NAMES } from "../src/protocol";

function fixture() {
	const calls: unknown[] = [];
	const session = { isBusyForSnapshot: false, navigateTree: async (...args: unknown[]) => { calls.push(args); return { cancelled: true }; }, getGoalModeState: () => ({ goal: {} }), goalRuntime: { onBudgetMutated: async (budget: unknown) => { calls.push(budget); return { goal: { tokenBudget: budget } }; } } } as unknown as AgentSession;
	const ctx = { memory: { status: async () => ({ backend: "off", active: false }), search: async (...args: unknown[]) => { calls.push(args); return { count: 0 }; }, save: async (input: unknown) => { calls.push(input); return { stored: 0 }; } } } as unknown as ExtensionContext;
	return { ctx, session, calls };
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
	test("backend disabled and zero stored results remain truthful", async () => {
		const { ctx, session } = fixture();
		expect(await nativeControl("memory.status", {}, ctx, session)).toEqual({ backend: "off", active: false });
		expect(await nativeControl("memory.save", { content: "note", importance: 0 }, ctx, session)).toEqual({ stored: 0 });
		await expect(nativeControl("memory.search", { query: "q", limit: 0 }, ctx, session)).rejects.toThrow("limit");
		await expect(nativeControl("memory.save", { content: "note", importance: Infinity }, ctx, session)).rejects.toThrow("finite");
		await expect(nativeControl("memory.status", { confirmed: true }, ctx, session)).rejects.toThrow("Unknown");
	});
});
