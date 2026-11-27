import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerGateway } from "../src/gateway";
import { GATEWAY_CODEX_API } from "../src/gateway-codex";
import { installSubagentModelGuard } from "../src/subagent-model";

const model = { id: "gpt-sol", name: "fixture", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 };

async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "noli-routing-"));
	const auth = await AuthStorage.create(join(dir, "agent.db"));
	writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: {
		"noli-codex": { baseUrl: "http://127.0.0.1:12345", api: "openai-responses", models: [model] },
		"noli-role-7461736b": { baseUrl: "http://127.0.0.1:12345", api: "openai-responses", route: "noli-codex", models: [model] },
		"noli-role-6f74686572": { baseUrl: "http://127.0.0.1:12345", api: "openai-responses", route: "noli-openai", models: [{ ...model, id: "plain" }] },
	} }));
	const registry = new ModelRegistry(auth, join(dir, "models.yml"), { settings: Settings.isolated({ enabledModels: ["noli-*/*"] }) });
	let spawn: ((event: unknown, ctx: unknown) => unknown) | undefined;
	const pi = {
		registerProvider: (name: string, config: never) => registry.registerProvider(name, config, "noli-test"),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { if (event === "before_subagent_spawn") spawn = handler; },
	} as unknown as ExtensionAPI;
	registerGateway(pi, dir);
	installSubagentModelGuard(pi);
	const ctx = { modelRegistry: registry };
	return { registry, spawn: (event: object) => spawn!({ type: "before_subagent_spawn", invocationKind: "task", agent: "probe", ...event }, ctx), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a Codex-backed role provider uses the Codex transport adapter; other routes do not", async () => {
	const f = await fixture();
	try {
		expect(f.registry.find("noli-codex", model.id)?.api).toBe(GATEWAY_CODEX_API);
		expect(f.registry.find("noli-role-7461736b", model.id)?.api).toBe(GATEWAY_CODEX_API);
		expect(f.registry.find("noli-role-6f74686572", "plain")?.api).toBe("openai-responses");
	} finally { f.cleanup(); }
});

test("a pinned unavailable gateway model blocks the spawn instead of running on another model", async () => {
	const f = await fixture();
	try {
		const blocked = f.spawn({ patterns: ["noli-codex/gpt-6.2-sol-pro"] }) as { block?: boolean; reason?: string };
		expect(blocked.block).toBe(true);
		expect(blocked.reason).toContain("noli-codex/gpt-6.2-sol-pro");
		expect(f.spawn({ patterns: ["noli-codex/gpt-sol:high"] })).toBeUndefined();
		expect(f.spawn({ patterns: ["noli-codex/missing", "noli-codex/gpt-sol"] })).toBeUndefined();
		expect(f.spawn({ patterns: ["noli-codex/missing"], modelRole: "task" })).toBeUndefined();
		expect(f.spawn({ patterns: ["other/model"] })).toBeUndefined();
	} finally { f.cleanup(); }
});
