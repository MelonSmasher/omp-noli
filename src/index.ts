import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Bridge, startBridge } from "./bridge";
import { createOmpHost } from "./omp-host";
import { installThreadControl } from "./thread-control";

/** Set by the launching app. Without both, the extension stays inert. */
export const ENV_DIR = "NOLI_BRIDGE_DIR";
export const ENV_TOKEN = "NOLI_BRIDGE_TOKEN";

export default function noli(pi: ExtensionAPI): void {
	let bridge: Bridge | undefined;
	installThreadControl(pi, sessionId => bridge?.hasAuthenticatedSession(sessionId) ?? false);
	const dir = process.env[ENV_DIR];
	const token = process.env[ENV_TOKEN];
	if (!dir || !token) return;

	const omp = createOmpHost(pi);

	const adopt = (ctx: ExtensionContext): void => {
		if (ctx.agent.kind !== "main") return;
		bridge?.invalidateAuthentication();
		omp.adopt(ctx);
		bridge ??= startBridge({ dir, token, host: omp.host });
	};

	pi.on("session_start", (_event, ctx) => adopt(ctx));
	pi.on("session_switch", (_event, ctx) => adopt(ctx));
	pi.on("session_branch", (_event, ctx) => adopt(ctx));
	pi.on("session_tree", (_event, ctx) => adopt(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		bridge?.close();
		bridge = undefined;
		omp.release();
	});
}
