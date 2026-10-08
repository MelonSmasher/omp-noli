import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";

export interface GatewayCredential { token: string; expires_ms: number }
export interface GatewayProviders {
	bind(credential: GatewayCredential): void;
	revoke(): void;
}

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

/** Re-register the bound launch's Gateway providers for another session in this process. */
export function rejoinGateway(pi: ExtensionAPI, dir: string | undefined): void {
	if (!dir || current?.dir !== dir) return;
	install(pi, dir);
	// The queued registration's live key covers everything until the session starts. Only a
	// started session joins, so a cancelled startup (which never starts or shuts down) is not
	// retained. Once started, OMP's runner applies registerProvider to the live registry.
	pi.on("session_start", () => { joined.add(pi); });
	pi.on("session_shutdown", () => { joined.delete(pi); });
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
		return [name, { baseUrl: config.baseUrl + suffix, api: config.api, models: config.models }];
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
			// SDK 18.8.2 ModelRegistry.registerProvider replaces authStorage.keys'
			// in-memory config; no OAuth login/credential persistence is involved.
			register(credential.token);
		},
		revoke() { register("noli-pending"); },
	};
}
