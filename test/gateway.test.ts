import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { registerGateway, rejoinGateway } from "../src/gateway";

const model = { id: "gateway-test", name: "Gateway fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 };

test("pinned SDK re-register refreshes existing model credentials only in memory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "noli-provider-"));
	const auth = await AuthStorage.create(join(dir, "agent.db"));
	try {
		writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: {
			"noli-openai": { baseUrl: "http://127.0.0.1:12345", api: "openai-completions", models: [model] },
			"noli-codex": { baseUrl: "http://127.0.0.1:12345", api: "openai-codex-responses", models: [model] },
		} }));
		const registry = new ModelRegistry(auth, join(dir, "models.yml"), { settings: Settings.isolated({ enabledModels: ["noli-*/*"] }) });
		const pi = { registerProvider: (name, config) => registry.registerProvider(name, config, "noli-test") } as Pick<ExtensionAPI, "registerProvider"> as ExtensionAPI;
		const gateway = registerGateway(pi, dir)!;
		const existing = registry.find("noli-openai", model.id)!;
		expect(existing.baseUrl).toBe("http://127.0.0.1:12345/v1");
		expect(registry.find("noli-codex", model.id)?.api).toBe("openai-codex-responses");
		expect(registry.find("noli-codex", model.id)?.baseUrl).toBe("http://127.0.0.1:12345");
		expect(await registry.getApiKey(existing)).toBe("noli-pending");
		const first = "a".repeat(43), second = "b".repeat(43);
		gateway.bind({ token: first, expires_ms: Date.now() + 60_000 });
		expect(await registry.getApiKey(existing)).toBe(first);
		gateway.bind({ token: second, expires_ms: Date.now() + 60_000 });
		expect(await registry.getApiKey(existing)).toBe(second);
		expect(registry.getAvailable().map(value => value.provider).sort()).toEqual(["noli-codex", "noli-openai"]);
		gateway.revoke();
		expect(await registry.getApiKey(existing)).toBe("noli-pending");
		for (const file of readdirSync(dir)) {
			const bytes = readFileSync(join(dir, file));
			expect(bytes.includes(Buffer.from(first))).toBe(false);
			expect(bytes.includes(Buffer.from(second))).toBe(false);
		}
	} finally { auth.close(); rmSync(dir, { recursive: true, force: true }); }
});

/**
 * A child session's factory API with SDK 18.8.2 ordering: registrations made while the
 * factory runs are queued (loader.ts); createAgentSession later clears this source and
 * applies the queue (sdk.ts). A cancelled startup never reaches session_start.
 */
function childSession(registry: ModelRegistry) {
	const queued: [string, ProviderConfig][] = [];
	const pi = {
		registerProvider: (name: string, config: ProviderConfig) => queued.push([name, config]),
		on: () => {},
	} as unknown as ExtensionAPI;
	return {
		pi,
		applyQueue() {
			registry.clearSourceRegistrations("noli-test");
			for (const [name, config] of queued.splice(0)) registry.registerProvider(name, config, "noli-test");
		},
	};
}

async function rootGateway() {
	const dir = mkdtempSync(join(tmpdir(), "noli-provider-"));
	const auth = await AuthStorage.create(join(dir, "agent.db"));
	writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: {
		"noli-openai": { baseUrl: "http://127.0.0.1:12345", api: "openai-completions", models: [model] },
	} }));
	const registry = new ModelRegistry(auth, join(dir, "models.yml"), { settings: Settings.isolated({ enabledModels: ["noli-*/*"] }) });
	const pi = { registerProvider: (name, config) => registry.registerProvider(name, config, "noli-test") } as Pick<ExtensionAPI, "registerProvider"> as ExtensionAPI;
	const gateway = registerGateway(pi, dir)!;
	const key = async () => { const found = registry.find("noli-openai", model.id); return found && await registry.getApiKey(found); };
	return { dir, registry, gateway, key, close: () => { auth.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a subagent of the bound root gets the Gateway models with the root's current credential", async () => {
	const root = await rootGateway();
	try {
		const token = "c".repeat(43);
		root.gateway.bind({ token, expires_ms: Date.now() + 60_000 });
		const child = childSession(root.registry);
		rejoinGateway(child.pi, root.dir);
		child.applyQueue();
		expect(root.registry.find("noli-openai", model.id)?.baseUrl).toBe("http://127.0.0.1:12345/v1");
		expect(await root.key()).toBe(token);
	} finally { root.close(); }
});

test("a bind or revoke between a child's factory and the SDK applying its queue is what gets installed", async () => {
	const root = await rootGateway();
	try {
		root.gateway.bind({ token: "d".repeat(43), expires_ms: Date.now() + 60_000 });
		const renewed = childSession(root.registry);
		rejoinGateway(renewed.pi, root.dir);
		const fresh = "e".repeat(43);
		root.gateway.bind({ token: fresh, expires_ms: Date.now() + 60_000 });
		// Applying the queue is the last thing a cancelled startup does; no later event repairs it.
		renewed.applyQueue();
		expect(await root.key()).toBe(fresh);
		const revoked = childSession(root.registry);
		rejoinGateway(revoked.pi, root.dir);
		root.gateway.revoke();
		revoked.applyQueue();
		expect(await root.key()).toBe("noli-pending");
	} finally { root.close(); }
});

test("a factory outside the bound root's launch never receives its credential", async () => {
	const root = await rootGateway();
	try {
		root.gateway.bind({ token: "f".repeat(43), expires_ms: Date.now() + 60_000 });
		for (const dir of [undefined, join(root.dir, "another-launch")]) {
			const registered: string[] = [];
			const pi = { registerProvider: (name: string) => registered.push(name), on: () => {} } as unknown as ExtensionAPI;
			rejoinGateway(pi, dir);
			expect(registered).toEqual([]);
		}
	} finally { root.close(); }
});

test("a session of the same launch with its own registry follows later binds and stops after shutdown", async () => {
	const root = await rootGateway();
	const auth = await AuthStorage.create(join(root.dir, "other.db"));
	try {
		const registry = new ModelRegistry(auth, join(root.dir, "other-models.yml"), { settings: Settings.isolated({ enabledModels: ["noli-*/*"] }) });
		let shutdown = () => {};
		const pi = {
			registerProvider: (name: string, config: ProviderConfig) => registry.registerProvider(name, config, "noli-test"),
			on: (event: string, handler: () => void) => { if (event === "session_shutdown") shutdown = handler; },
		} as unknown as ExtensionAPI;
		root.gateway.bind({ token: "g".repeat(43), expires_ms: Date.now() + 60_000 });
		rejoinGateway(pi, root.dir);
		const key = async () => await registry.getApiKey(registry.find("noli-openai", model.id)!);
		expect(await key()).toBe("g".repeat(43));
		root.gateway.bind({ token: "h".repeat(43), expires_ms: Date.now() + 60_000 });
		expect(await key()).toBe("h".repeat(43));
		root.gateway.revoke();
		expect(await key()).toBe("noli-pending");
		shutdown();
		root.gateway.bind({ token: "i".repeat(43), expires_ms: Date.now() + 60_000 });
		expect(await key()).toBe("noli-pending");
	} finally { auth.close(); root.close(); }
});
