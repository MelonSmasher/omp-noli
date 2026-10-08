import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";

export interface GatewayCredential { token: string; expires_ms: number }
export interface GatewayProviders {
	bind(credential: GatewayCredential): void;
	revoke(): void;
}

/**
 * The root session's catalog and current credential, kept in memory only.
 * Subagent sessions in the same process re-run every extension factory, and the
 * SDK clears this extension's provider registrations before applying the new
 * session's. The bootstrap is consumed by then, so a child re-registers from here.
 */
let current: { providers: [string, ProviderConfig][]; apiKey: string } | undefined;

/** Re-register the root's Gateway providers for a subagent session; no-op without a bound root. */
export function rejoinGateway(pi: ExtensionAPI): void {
	if (!current) return;
	for (const [name, config] of current.providers) pi.registerProvider(name, { ...config, apiKey: current.apiKey });
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
		current = { providers, apiKey };
		// The registry is shared with subagent sessions, so this also refreshes their credential.
		for (const [name, config] of providers) pi.registerProvider(name, { ...config, apiKey });
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
