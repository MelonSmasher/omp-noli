import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { resolveCacheRetention, streamSimple, type Model, type ResolvedAnthropicCompat } from "@oh-my-pi/pi-ai";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { GATEWAY_CODEX_API, gatewayCodexCompat, streamGatewayCodex } from "./gateway-codex";

export interface GatewayCredential { token: string; expires_ms: number }
export interface GatewayProviders {
	bind(credential: GatewayCredential): void;
	revoke(): void;
}

const GATEWAY_ANTHROPIC_API = "noli-anthropic-messages";

function gatewayAnthropicCompat(model: Model) {
	// Custom APIs have no resolved record. Keep sparse discovery overrides and
	// any later effective model overrides when resolving the actual wire API.
	return resolveModelPolicy({ ...model, api: "anthropic-messages", isOAuth: false,
		compat: { ...model.compatConfig, ...model.compat } }).compat as ResolvedAnthropicCompat;
}

/** A local Gateway bearer is not a provider OAuth identity. Keep the stock
 * serializer and its option mapping; only adapt authentication and private
 * dispatch attribution. Explicit metadata is never removed or reconstructed. */
const streamGatewayAnthropic: NonNullable<ProviderConfig["streamSimple"]> = (model, context, options) => {
	const wireModel = { ...model, api: "anthropic-messages" as const, isOAuth: false, compat: gatewayAnthropicCompat(model) };
	return streamSimple(wireModel, context, {
		...options,
		// Non-OAuth local authentication must not shorten the established cache
		// lifetime. Explicit options and the stock environment override still win.
		cacheRetention: resolveCacheRetention(options?.cacheRetention, wireModel.compat?.supportsLongCacheRetention ? "long" : "short"),
		headers: { ...options?.headers, ...(options?.sessionId && { "x-noli-producer-session-id": options.sessionId }) },
		onPayload: options?.onPayload ? payload => options.onPayload!(payload, model) : undefined,
		// The custom API dispatcher already owns these guards. Acquiring another
		// slot would deadlock at limit=1; firing beforeDispatch twice is also wrong.
		maxInFlightRequests: {}, beforeDispatch: undefined, loopGuard: { enabled: false },
	});
};

/**
 * The bound root session's catalog and current credential, kept in memory only.
 * Subagent sessions in the same process re-run every extension factory, and the
 * SDK clears this extension's provider registrations before applying the new
 * session's. The bootstrap is consumed by then, so a child re-registers from here.
 *
 * Noli issues one capability per managed OMP launch, identified by NOLI_BRIDGE_DIR.
 * Every session in that process (task subagents, /tan, commit and compaction
 * agents) is that launch's own work, so a factory for the same directory may use it;
 * a factory for any other or no directory gets nothing.
 */
let current: { dir: string; providers: [string, ProviderConfig][]; apiKey: string } | undefined;
/** Sessions that rejoined, so a bind or revoke also reaches ones with their own registry. */
const joined = new Set<ExtensionAPI>();

function install(pi: ExtensionAPI, dir: string): void {
	if (current?.dir !== dir) return;
	for (const [name, config] of current.providers) {
		// The SDK queues a factory's registrations and applies them after clearing this
		// source, so the key is read then, never captured now: a bind or revoke in between,
		// or a startup that is later cancelled, can't install a stale credential.
		pi.registerProvider(name, Object.defineProperty({ ...config }, "apiKey", {
			enumerable: true,
			get: () => current?.dir === dir ? current.apiKey : "noli-pending",
		}));
	}
}

/** Only transports registered by this launch can attach authenticated producer context. */
export function isGatewayModel(model: { provider: string; api: string } | undefined): boolean {
	return !!model && [GATEWAY_ANTHROPIC_API, GATEWAY_CODEX_API, "openai-responses", "openai-codex-responses"].includes(model.api)
		&& !!current?.providers.some(([name, config]) => name === model.provider && config.api === model.api);
}

const enrichedRegistries = new WeakSet<ExtensionContext["modelRegistry"]>();

/** Enrich the real resolved models before stock serializers build request headers. */
export function enrichGatewayModels(ctx: Pick<ExtensionContext, "modelRegistry" | "model">): void {
	const enrich = (model: Model | undefined): void => {
		if (!model || !isGatewayModel(model)) return;
		if (model.api === GATEWAY_ANTHROPIC_API) {
			// Main-loop facts and helpers must observe the same tool/cache policy
			// as the serializer, including retained models after registry refresh.
			model.compat ??= gatewayAnthropicCompat(model);
			return;
		}
		if (model.api === GATEWAY_CODEX_API) {
			model.compat ??= gatewayCodexCompat(model);
			return;
		}
		if (model.api !== "openai-responses") return;
		// SDK 18.19's raw compat overrides omit optional keys absent from its
		// default record. Configure this supported serializer field on the actual
		// resolved model instead. No identity, API, instructions or history change.
		if (!model.compat) throw new Error("Managed Responses model lacks resolved compatibility metadata");
		Object.assign(model.compat, { sessionHeader: "x-noli-producer-session-id" });
	};
	const registry = ctx.modelRegistry;
	if (!enrichedRegistries.has(registry)) {
		// Advisors retain models across catalog/credential refreshes. Their public
		// credential resolver receives the actual request model before serialization;
		// catalog enumeration alone cannot reach these retained objects. Adapt this
		// registry instance only, preserving both resolver overloads and all arguments.
		const resolve = registry.resolver;
		registry.resolver = function (this: ExtensionContext["modelRegistry"], ...args: Parameters<typeof resolve>) {
			const target = args[0];
			if (typeof target === "object" && target !== null) enrich(target as Model);
			return Reflect.apply(resolve, this, args);
		} as typeof resolve;
		enrichedRegistries.add(registry);
	}
	for (const [name, config] of current?.providers ?? []) {
		if (!["openai-responses", GATEWAY_ANTHROPIC_API, GATEWAY_CODEX_API].includes(config.api ?? "")) continue;
		for (const model of ctx.modelRegistry.getProviderModels(name)) enrich(model);
	}
	// The selected model may predate a registry refresh; side turns use it too.
	enrich(ctx.model);
}


/** Re-register the bound launch's Gateway providers for another session in this process; false when it is not that launch's. */
export function rejoinGateway(pi: ExtensionAPI, dir: string | undefined): boolean {
	if (!dir || current?.dir !== dir) return false;
	install(pi, dir);
	// The queued registration's live key covers everything until the session starts. Only a
	// started session joins, so a cancelled startup (which never starts or shuts down) is not
	// retained. Once started, OMP's runner applies registerProvider to the live registry.
	pi.on("session_start", () => { joined.add(pi); });
	pi.on("session_shutdown", () => { joined.delete(pi); });
	return true;
}

/** Factory-time catalog registration precedes OMP's initial model selection. */
export function registerGateway(pi: ExtensionAPI, dir: string): GatewayProviders | undefined {
	let text: string;
	try { text = readFileSync(join(dir, "gateway-providers.json"), "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error("Cannot read Noli gateway catalog");
	}
	const data: unknown = JSON.parse(text);
	if (!data || typeof data !== "object" || !("providers" in data) || !data.providers || typeof data.providers !== "object") {
		throw new Error("Invalid Noli gateway catalog");
	}
	const providers = Object.entries(data.providers).map(([name, value]): [string, ProviderConfig] => {
		if (!/^noli-[a-z0-9-]+$/.test(name) || !value || typeof value !== "object") throw new Error("Invalid Noli gateway provider");
		const config = value as ProviderConfig;
		if (!config.baseUrl || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(config.baseUrl) || !config.api || !Array.isArray(config.models) || !config.models.length) {
			throw new Error("Invalid Noli gateway provider configuration");
		}
		// Native transports append different paths. Keep the manifest origin-only.
        const suffix = config.api === "google-generative-ai" ? "/v1beta" : ["anthropic-messages", "openai-codex-responses"].includes(config.api) ? "" : "/v1";
		const codex = name === "noli-codex" && config.api === "openai-responses";
		return [name, { baseUrl: config.baseUrl + suffix,
			api: codex ? GATEWAY_CODEX_API : config.api === "anthropic-messages" ? GATEWAY_ANTHROPIC_API : config.api,
			models: config.models, ...(codex ? { streamSimple: streamGatewayCodex }
				: config.api === "anthropic-messages" ? { streamSimple: streamGatewayAnthropic } : {}) }];
	});
	const register = (apiKey: string): void => {
		current = { dir, providers, apiKey };
		for (const [name, config] of providers) pi.registerProvider(name, { ...config, apiKey });
		// Sessions sharing the root's registry already see this; ones with their own need it pushed.
		for (const other of joined) install(other, dir);
	};
	register("noli-pending");
	return {
		bind(credential) {
			if (typeof credential.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(credential.token) || !Number.isSafeInteger(credential.expires_ms) || credential.expires_ms <= Date.now()) {
				throw new Error("Invalid Noli gateway binding");
			}
			// SDK 18.13.2 ModelRegistry.registerProvider replaces authStorage.keys'
			// in-memory config; no OAuth login/credential persistence is involved.
			register(credential.token);
		},
		revoke() { register("noli-pending"); },
	};
}
