import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerGateway } from "../src/gateway";

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
