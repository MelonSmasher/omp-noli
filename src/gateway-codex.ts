import type { ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { streamSimple, type Context, type Model } from "@oh-my-pi/pi-ai";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";

export const GATEWAY_CODEX_API = "noli-codex-responses";

export function gatewayCodexCompat(model: Model): Model<"openai-responses">["compat"] {
	const compat = resolveModelPolicy({ ...model, api: "openai-responses",
		compat: { ...model.compatConfig, ...model.compat } }).compat as Model<"openai-responses">["compat"];
	return Object.assign({ ...compat }, { sessionHeader: "x-noli-producer-session-id" });
}

function originalReasoningIds(context: Context, provider: string): Map<string, string | null> {
	const ids = new Map<string, string | null>();
	const collect = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		const item = value as Record<string, unknown>;
		if (item.type !== "reasoning" || typeof item.id !== "string" || !item.id || typeof item.encrypted_content !== "string") return;
		const previous = ids.get(item.encrypted_content);
		ids.set(item.encrypted_content, previous === undefined || previous === item.id ? item.id : null);
	};
	for (const message of context.messages) {
		if (message.role !== "assistant" || message.provider !== provider) continue;
		const payload = message.providerPayload;
		if (payload?.type === "openaiResponsesHistory" && (payload.provider ?? message.provider) === provider) {
			for (const item of payload.items) collect(item);
		}
		for (const block of message.content) {
			if (block.type !== "thinking" || !block.thinkingSignature) continue;
			try { collect(JSON.parse(block.thinkingSignature)); } catch { /* Not a Responses signature. */ }
		}
	}
	return ids;
}

/** REST permits an omitted reasoning id; Codex import instead invents one,
 * breaking the encrypted item's binding. Recover only the exact source id.
 * The map belongs to this stream call, never a session/global "latest context". */
export const streamGatewayCodex: NonNullable<ProviderConfig["streamSimple"]> = (model, context, options) => {
	const wireModel = { ...model, api: "openai-responses" as const, compat: gatewayCodexCompat(model) };
	let ids: Map<string, string | null> | undefined;
	return streamSimple(wireModel, context, {
		...options,
		onPayload: async payload => {
			let restored = payload;
			if (payload && typeof payload === "object" && "input" in payload && Array.isArray(payload.input)) {
				let input: unknown[] | undefined;
				for (let index = 0; index < payload.input.length; index++) {
					const item = payload.input[index];
					if (item?.type !== "reasoning" || typeof item.encrypted_content !== "string" || item.id != null) continue;
					ids ??= originalReasoningIds(context, model.provider);
					const id = ids.get(item.encrypted_content);
					if (!id) throw new Error("Codex encrypted reasoning requires its original response item ID; no unambiguous source ID is available.");
					input ??= payload.input.slice();
					input[index] = { ...item, id };
				}
				if (input) restored = { ...payload, input };
			}
			return (await options?.onPayload?.(restored, model)) ?? restored;
		},
		// The outer custom-API dispatcher owns concurrency and dispatch once.
		maxInFlightRequests: {}, beforeDispatch: undefined, loopGuard: { enabled: false },
	});
};
