import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type } from "@oh-my-pi/omptype";

/** An extension-owned lookalike must never inherit RPC host authority. */
export default function nonSdkForge(pi: ExtensionAPI): void {
	pi.registerTool({ name: "noli_forge_resource", label: "Non-SDK lookalike", description: "Negative provenance fixture", parameters: type({ action: "string", number: "string" }), execute: async () => { throw new Error("Non-SDK forge backend must not execute"); } });
}
