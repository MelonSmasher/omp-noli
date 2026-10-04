import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Bridge, startBridge } from "./bridge";
import { installImagePublisher } from "./images";
import { createOmpHost } from "./omp-host";
import { installThreadControl } from "./thread-control";

/** Set by the launching app. Without both, the extension stays inert. */
export const ENV_DIR = "NOLI_BRIDGE_DIR";
export const ENV_TOKEN = "NOLI_BRIDGE_TOKEN";

export default function noli(pi: ExtensionAPI): void {
	let bridge: Bridge | undefined;
	let boundSession: string | undefined;
	installThreadControl(pi, sessionId => bridge?.hasAuthenticatedSession(sessionId) ?? false);
	const dir = process.env[ENV_DIR];
	const token = process.env[ENV_TOKEN];
	if (!dir || !token) return;
	installImagePublisher(pi, sessionId => bridge?.hasAuthenticatedSession(sessionId) ?? false);

	const omp = createOmpHost(pi);

	const adopt = (ctx: ExtensionContext): void => {
		if (ctx.agent.kind !== "main") return;
		const sessionId = ctx.sessionManager.getSessionId();
		// Tree navigation changes the leaf, not admission identity. Keep its correlated response authenticated.
		if (boundSession === sessionId) { omp.refreshContext(ctx); return; }
		boundSession = sessionId;
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
		boundSession = undefined;
		omp.release();
	});
}
