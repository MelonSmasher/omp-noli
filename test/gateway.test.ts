import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { generateTaskLabel } from "@oh-my-pi/pi-coding-agent/task/label";
import { streamSimple, type AssistantMessage, type Context } from "@oh-my-pi/pi-ai";
import { enrichGatewayModels, registerGateway, rejoinGateway } from "../src/gateway";

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
		const expectAvailable = () => expect(registry.getAvailable()
			.filter(candidate => candidate.id === model.id)
			.map(candidate => candidate.provider).sort()).toEqual(["noli-codex", "noli-openai"]);
		expectAvailable();
		const first = "a".repeat(43), second = "b".repeat(43);
		gateway.bind({ token: first, expires_ms: Date.now() + 60_000 });
		expect(await registry.getApiKey(existing)).toBe(first);
		expectAvailable();
		gateway.bind({ token: second, expires_ms: Date.now() + 60_000 });
		expect(await registry.getApiKey(existing)).toBe(second);
		expectAvailable();
		gateway.revoke();
		expect(await registry.getApiKey(existing)).toBe("noli-pending");
		expectAvailable();
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

test("a session of the same launch with its own registry follows later binds once started, and stops after shutdown", async () => {
	const root = await rootGateway();
	const auth = await AuthStorage.create(join(root.dir, "other.db"));
	try {
		const registry = new ModelRegistry(auth, join(root.dir, "other-models.yml"), { settings: Settings.isolated({ enabledModels: ["noli-*/*"] }) });
		// SDK 18.8.2: queued during the factory (loader.ts), drained at session creation (sdk.ts),
		// then applied to the live registry (runner.ts) once the runner is initialized.
		const queued: [string, ProviderConfig][] = [];
		let live = false;
		const handlers = new Map<string, () => void>();
		const pi = {
			registerProvider: (name: string, config: ProviderConfig) => live ? registry.registerProvider(name, config, "noli-test") : queued.push([name, config]),
			on: (event: string, handler: () => void) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		root.gateway.bind({ token: "g".repeat(43), expires_ms: Date.now() + 60_000 });
		rejoinGateway(pi, root.dir);
		for (const [name, config] of queued.splice(0)) registry.registerProvider(name, config, "noli-test");
		live = true;
		handlers.get("session_start")!();
		const key = async () => await registry.getApiKey(registry.find("noli-openai", model.id)!);
		expect(await key()).toBe("g".repeat(43));
		root.gateway.bind({ token: "h".repeat(43), expires_ms: Date.now() + 60_000 });
		expect(await key()).toBe("h".repeat(43));
		root.gateway.revoke();
		expect(await key()).toBe("noli-pending");
		handlers.get("session_shutdown")!();
		root.gateway.bind({ token: "i".repeat(43), expires_ms: Date.now() + 60_000 });
		expect(await key()).toBe("noli-pending");
	} finally { auth.close(); root.close(); }
});

test("a session whose startup is cancelled is never retained for later binds", async () => {
	const root = await rootGateway();
	try {
		let calls = 0;
		const pi = { registerProvider: () => { calls++; }, on: () => {} } as unknown as ExtensionAPI;
		root.gateway.bind({ token: "j".repeat(43), expires_ms: Date.now() + 60_000 });
		rejoinGateway(pi, root.dir);
		const queuedAtFactory = calls;
		// Cancelled: neither session_start nor session_shutdown ever fires.
		root.gateway.bind({ token: "k".repeat(43), expires_ms: Date.now() + 60_000 });
		root.gateway.revoke();
		expect(calls).toBe(queuedAtFactory);
	} finally { root.close(); }
});

test("an advisor selected before binding retains actual dispatch headers after credential changes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "noli-advisor-binding-"));
	const received: Array<{ body: string; headers: Headers }> = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		received.push({ body: await request.text(), headers: request.headers });
		return Response.json({ error: { message: "synthetic non-retryable rejection" } }, { status: 400 });
	} });
	const auth = await AuthStorage.create(join(dir, "agent.db"));
	try {
		writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: {
			"noli-openai": { baseUrl: `http://127.0.0.1:${server.port}`, api: "openai-responses", models: [model] },
			"noli-anthropic": { baseUrl: `http://127.0.0.1:${server.port}`, api: "anthropic-messages", models: [model] },
		} }));
		const registry = new ModelRegistry(auth, join(dir, "models.yml"), { settings: Settings.isolated({ enabledModels: ["noli-*/*"] }) });
		const pi = { registerProvider: (name: string, config: ProviderConfig) => registry.registerProvider(name, config, "advisor-binding") } as ExtensionAPI;
		const gateway = registerGateway(pi, dir)!;
		// Actual OMP advisors capture a model before the managed launch binds.
		const advisor = registry.getAvailable().find(candidate => candidate.provider === "noli-openai")!;
		const sessionId = "019a0000-0000-7000-8000-000000000001";
		for (const token of ["a".repeat(43), "b".repeat(43)]) {
			gateway.bind({ token, expires_ms: Date.now() + 60_000 });
			enrichGatewayModels({ modelRegistry: registry, model: registry.find("noli-anthropic", model.id) });
			await streamSimple(advisor, { messages: [{ role: "user", content: "unchanged advisor input", timestamp: 1 }] }, {
				apiKey: registry.resolver(advisor, sessionId), sessionId,
			}).result();
			const request = received.at(-1)!;
			expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
			expect(request.headers.get("x-noli-producer-session-id")).toBe(sessionId);
			expect(JSON.parse(request.body).prompt_cache_key).toBe(sessionId);
			expect(JSON.stringify(JSON.parse(request.body).input)).toContain("unchanged advisor input");
		}
	} finally { server.stop(true); auth.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("managed Anthropic helpers omit generated identity but preserve caller metadata and dispatch ownership", async () => {
	const dir = mkdtempSync(join(tmpdir(), "noli-anthropic-helper-"));
	const received: Array<{ body: Record<string, any>; headers: Headers }> = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		received.push({ body: await request.json() as Record<string, any>, headers: request.headers });
		const events = [
			{ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "<title>Inspect compiler diagnostics</title>" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } },
			{ type: "message_stop" },
		];
		return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	} });
	const auth = await AuthStorage.create(join(dir, "agent.db"));
	const settings = Settings.isolated({ enabledModels: ["noli-*/*"], modelRoles: { tiny: `noli-anthropic/${model.id}` } });
	const registry = new ModelRegistry(auth, join(dir, "models.yml"), { settings });
	try {
		writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: {
			"noli-anthropic": { baseUrl: `http://127.0.0.1:${server.port}`, api: "anthropic-messages", models: [model] },
		} }));
		const pi = { registerProvider: (name: string, config: ProviderConfig) => registry.registerProvider(name, config, "native-helper") } as ExtensionAPI;
		const gateway = registerGateway(pi, dir)!;
		gateway.bind({ token: "a".repeat(43), expires_ms: Date.now() + 60_000 });
		const signal = AbortSignal.timeout(10_000);
		const label = await generateTaskLabel("Inspect the compiler diagnostics and fix the type error", registry, settings, "task-label-session", signal);
		expect(label).toBe("Inspect compiler diagnostics");
		expect(received).toHaveLength(1);
		expect(received[0]!.body.metadata).toBeUndefined();
		expect(received[0]!.headers.get("x-noli-producer-session-id")).toBe("task-label-session");
		expect(received[0]!.headers.get("authorization")).toBe(`Bearer ${"a".repeat(43)}`);
		// Retained models and concurrent helpers must not borrow another request's
		// identity or keep an old credential after a normal registry re-registration.
		const retained = registry.find("noli-anthropic", model.id)!;
		gateway.bind({ token: "b".repeat(43), expires_ms: Date.now() + 60_000 });
		let dispatched = 0;
		await Promise.all(["main-session", "parent:side:conversation:topic"].map(async sessionId => {
			const metadata = { user_id: JSON.stringify({ session_id: sessionId, custom: "must remain visible" }) };
			const response = await streamSimple(retained, { systemPrompt: ["Original instructions"], messages: [{ role: "user", content: sessionId, timestamp: 1 }] }, {
				apiKey: registry.resolver(retained, sessionId), sessionId, metadata, signal,
				maxInFlightRequests: { "noli-anthropic": 1 }, beforeDispatch: () => { dispatched++; },
			}).result();
			expect(response.stopReason).toBe("stop");
			const sent = received.find(item => item.headers.get("x-noli-producer-session-id") === sessionId)!;
			expect(sent.body.metadata).toEqual(metadata);
			expect(sent.headers.get("authorization")).toBe(`Bearer ${"b".repeat(43)}`);
			expect(JSON.stringify(sent.body.system)).toContain("Original instructions");
		}));
		expect(dispatched).toBe(2);
		expect(received).toHaveLength(3);
	} finally {
		registry.clearSourceRegistrations("native-helper");
		server.stop(true); auth.close(); rmSync(dir, { recursive: true, force: true });
	}
}, 15_000);

test("scoped Anthropic dispatch preserves model sampling compatibility overrides", async () => {
	const dir = mkdtempSync(join(tmpdir(), "noli-anthropic-controls-"));
	const received: Array<Record<string, unknown>> = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		received.push(await request.json() as Record<string, unknown>);
		return Response.json({ error: { message: "synthetic non-retryable rejection" } }, { status: 400 });
	} });
	const auth = await AuthStorage.create(join(dir, "agent.db"));
	const registry = new ModelRegistry(auth, join(dir, "models.yml"), { settings: Settings.isolated({ enabledModels: ["noli-*/*"] }) });
	try {
		writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: {
			"noli-anthropic": { baseUrl: `http://127.0.0.1:${server.port}`, api: "anthropic-messages",
				models: [false, true].map(sampling => ({ ...model, id: sampling ? "metered" : "native",
					compat: { supportsSamplingParams: sampling, injectClaudeCodeInstruction: false } })) },
		} }));
		const pi = { registerProvider: (name: string, config: ProviderConfig) => registry.registerProvider(name, config, "sampling-controls") } as ExtensionAPI;
		registerGateway(pi, dir)!.bind({ token: "a".repeat(43), expires_ms: Date.now() + 60_000 });
		for (const id of ["native", "metered"]) {
			const selected = registry.find("noli-anthropic", id)!;
			await streamSimple(selected, { messages: [{ role: "user", content: "Helper request", timestamp: 1 }] }, {
				apiKey: registry.resolver(selected, "helper"), sessionId: "helper", temperature: 0.25, topP: 0.7,
			}).result();
			const request = received.at(-1)!;
			expect(request.temperature).toBe(id === "metered" ? 0.25 : undefined);
			expect(request.top_p).toBe(id === "metered" ? 0.7 : undefined);
		}
	} finally {
		registry.clearSourceRegistrations("sampling-controls");
		server.stop(true); auth.close(); rmSync(dir, { recursive: true, force: true });
	}
});

test("scoped Anthropic authentication preserves cache retention and caller precedence", async () => {
	const dir = mkdtempSync(join(tmpdir(), "noli-anthropic-cache-"));
	const received: Array<Record<string, any>> = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		received.push(await request.json() as Record<string, any>);
		return Response.json({ error: { message: "synthetic non-retryable rejection" } }, { status: 400 });
	} });
	const auth = await AuthStorage.create(join(dir, "agent.db"));
	const registry = new ModelRegistry(auth, join(dir, "models.yml"), { settings: Settings.isolated({ enabledModels: ["noli-*/*"] }) });
	const previousRetention = process.env.PI_CACHE_RETENTION;
	try {
		delete process.env.PI_CACHE_RETENTION;
		writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: {
			"noli-anthropic": { baseUrl: `http://127.0.0.1:${server.port}`, api: "anthropic-messages",
				models: [false, true].map(long => ({ ...model, id: long ? "long" : "short",
					compat: { supportsLongCacheRetention: long, injectClaudeCodeInstruction: false } })) },
		} }));
		const pi = { registerProvider: (name: string, config: ProviderConfig) => registry.registerProvider(name, config, "cache-controls") } as ExtensionAPI;
		registerGateway(pi, dir)!.bind({ token: "a".repeat(43), expires_ms: Date.now() + 60_000 });
		for (const id of ["long", "short"]) {
			const selected = registry.find("noli-anthropic", id)!;
			for (const cacheRetention of [undefined, "long", "short", "none"] as const) {
				await streamSimple(selected, { messages: [{ role: "user", content: "Cache prefix stays intact", timestamp: 1 }] }, {
					apiKey: registry.resolver(selected, "cache-session"), sessionId: "cache-session", cacheRetention,
				}).result();
				const sent = received.at(-1)!;
				const content = sent.messages[0].content;
				const blocks = Array.isArray(content) ? content : [{ type: "text", text: content }];
				expect(blocks.map(block => block.text).join("")).toBe("Cache prefix stays intact");
				expect(blocks.flatMap(block => block.cache_control ? [block.cache_control] : [])).toEqual(cacheRetention === "none" ? [] : [
					{ type: "ephemeral", ...(id === "long" && cacheRetention !== "short" ? { ttl: "1h" } : {}) },
				]);
			}
		}
		const selected = registry.find("noli-anthropic", "long")!;
		process.env.PI_CACHE_RETENTION = "short";
		for (const cacheRetention of [undefined, "long"] as const) {
			await streamSimple(selected, { messages: [{ role: "user", content: "Explicit retention wins", timestamp: 1 }] }, {
				apiKey: registry.resolver(selected, "cache-session"), sessionId: "cache-session", cacheRetention,
			}).result();
			expect(received.at(-1)!.messages[0].content[0].cache_control).toEqual({ type: "ephemeral", ...(cacheRetention === "long" ? { ttl: "1h" } : {}) });
		}
	} finally {
		if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = previousRetention;
		registry.clearSourceRegistrations("cache-controls");
		server.stop(true); auth.close(); rmSync(dir, { recursive: true, force: true });
	}
});

test("Codex continuation preserves the encrypted item's original ID after SDK replay and resume", async () => {
	const dir = mkdtempSync(join(tmpdir(), "noli-codex-replay-"));
	const reasoning = { type: "reasoning", id: "rs_original", summary: [{ type: "summary_text", text: "Synthetic summary" }], encrypted_content: "synthetic-bound-to-rs_original" };
	const text = { type: "message", id: "msg_original", role: "assistant", content: [{ type: "output_text", text: "Synthetic progress", annotations: [] }] };
	const received: Array<{ input: typeof reasoning[]; headers: Headers }> = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.json();
		received.push({ input: body.input, headers: request.headers });
		const item = body.input.find((item: typeof reasoning) => item.type === "reasoning");
		if (item?.id !== reasoning.id || item?.encrypted_content !== reasoning.encrypted_content) {
			return Response.json({ error: { code: "invalid_encrypted_content", message: "Synthetic encrypted item binding mismatch" } }, { status: 400 });
		}
		const output = { ...text, id: "msg_reply", content: [{ type: "output_text", text: "CONTINUED", annotations: [] }] };
		const events = [{ type: "response.output_item.added", output_index: 0, item: { ...output, content: [] } },
			{ type: "response.output_item.done", output_index: 0, item: output },
			{ type: "response.completed", response: { id: "resp_done", status: "completed", output: [output], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }];
		return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	} });
	const auth = await AuthStorage.create(join(dir, "agent.db"));
	const registry = new ModelRegistry(auth, join(dir, "models.yml"), { settings: Settings.isolated({ enabledModels: ["noli-*/*"] }) });
	try {
		writeFileSync(join(dir, "gateway-providers.json"), JSON.stringify({ providers: {
			"noli-codex": { baseUrl: `http://127.0.0.1:${server.port}`, api: "openai-responses", models: [{ ...model, reasoning: true }] },
		} }));
		const pi = { registerProvider: (name: string, config: ProviderConfig) => registry.registerProvider(name, config, "codex-replay") } as ExtensionAPI;
		registerGateway(pi, dir)!.bind({ token: "a".repeat(43), expires_ms: Date.now() + 60_000 });
		const selected = registry.find("noli-codex", model.id)!;
		enrichGatewayModels({ modelRegistry: registry, model: selected });
		const assistant: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "noli-codex", model: model.id,
			content: [{ type: "thinking", thinking: "Synthetic summary", thinkingSignature: JSON.stringify(reasoning) }, { type: "text", text: "Synthetic progress" }],
			providerPayload: { type: "openaiResponsesHistory", provider: "noli-codex", dt: true, items: [reasoning, text] },
			stopReason: "stop", timestamp: 1, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		const context: Context = { messages: [assistant, { role: "user", content: "Continue", timestamp: 2 }] };
		const original = JSON.stringify(context);
		for (const sessionId of ["main", "resumed-helper"]) {
			const source: Context = sessionId === "main" ? context : JSON.parse(original);
			let dispatches = 0;
			let responseStatus: number | undefined;
			const events: Array<string | null> = [];
			const result = await streamSimple(selected, source, {
				apiKey: registry.resolver(selected, sessionId), sessionId, maxInFlightRequests: { "noli-codex": 1 },
				beforeDispatch: async () => { dispatches++; },
				onPayload: payload => { expect((payload as { input: typeof reasoning[] }).input.find(item => item.type === "reasoning")).toEqual(reasoning); },
				onResponse: (response, callbackModel) => { if (callbackModel === selected) responseStatus = response.status; },
				onSseEvent: (event, callbackModel) => { if (callbackModel === selected) events.push(event.event); },
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "CONTINUED" }));
			expect(dispatches).toBe(1);
			expect(responseStatus).toBe(200);
			expect(events).toContain("response.completed");
			expect(received.at(-1)!.headers.get("x-noli-producer-session-id")).toBe(sessionId);
			expect(JSON.stringify(source)).toBe(original);
		}
		const broken = JSON.parse(original) as Context;
		const history = broken.messages[0] as AssistantMessage;
		history.content = [{ type: "text", text: "Synthetic progress" }];
		delete (history.providerPayload as { items: Array<{ id?: string }> }).items[0]!.id;
		const before = received.length;
		const rejected = await streamSimple(selected, broken, { apiKey: "synthetic-only" }).result();
		expect(rejected.stopReason).toBe("error");
		expect(rejected.errorMessage).toContain("original response item ID");
		expect(received.length).toBe(before);
		const ambiguous = JSON.parse(original) as Context;
		const ambiguousHistory = ambiguous.messages[0] as AssistantMessage;
		delete ambiguousHistory.providerPayload;
		ambiguousHistory.content.unshift({ type: "thinking", thinking: "Conflicting retained signature",
			thinkingSignature: JSON.stringify({ ...reasoning, id: "rs_conflicting" }) });
		const conflict = await streamSimple(selected, ambiguous, { apiKey: "synthetic-only" }).result();
		expect(conflict.stopReason).toBe("error");
		expect(conflict.errorMessage).toContain("original response item ID");
		expect(received.length).toBe(before);
	} finally {
		registry.clearSourceRegistrations("codex-replay");
		server.stop(true); auth.close(); rmSync(dir, { recursive: true, force: true });
	}
});
