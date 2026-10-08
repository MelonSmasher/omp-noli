import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Bridge, startBridge } from "./bridge";
import { installImagePublisher } from "./images";
import { createOmpHost } from "./omp-host";
import { installThreadControl } from "./thread-control";
import { registerGateway, rejoinGateway } from "./gateway";

/** Set by the launcher; a directory and bootstrap input enable Bridge and Gateway setup. */
export const ENV_DIR = "NOLI_BRIDGE_DIR";
export const ENV_TOKEN_FILE = "NOLI_BRIDGE_TOKEN_FILE";

/** The launch environment contains only a path; Bun children cannot inherit secret bytes. */
function consumeBootstrap(path: string): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
			|| (typeof process.getuid === "function" && stat.uid !== process.getuid())
			|| stat.size < 1 || stat.size > 4096) throw new Error("Invalid Noli bootstrap file");
		try { return readFileSync(fd, "utf8"); }
		finally { unlinkSync(path); }
	} finally { closeSync(fd); }
}

export default function noli(pi: ExtensionAPI): void {
	let bridge: Bridge | undefined;
	let boundSession: string | undefined;
	installThreadControl(pi, sessionId => bridge?.hasAuthenticatedSession(sessionId) ?? false);
	const dir = process.env[ENV_DIR];
	const tokenFile = process.env[ENV_TOKEN_FILE];
	const legacyToken = process.env.NOLI_BRIDGE_TOKEN;
	delete process.env[ENV_TOKEN_FILE];
	delete process.env.NOLI_BRIDGE_TOKEN;
	// A subagent session re-runs this factory after the root consumed the bootstrap; it only needs the Gateway models.
	if (!dir || (!tokenFile && !legacyToken)) { rejoinGateway(pi); return; }
	if (!tokenFile && existsSync(join(dir, "gateway-providers.json"))) {
		throw new Error("Noli gateway binding requires NOLI_BRIDGE_TOKEN_FILE");
	}
	const token = tokenFile ? consumeBootstrap(tokenFile) : legacyToken!;
	installImagePublisher(pi, sessionId => bridge?.hasAuthenticatedSession(sessionId) ?? false);
    const gateway = registerGateway(pi, dir);

	const omp = createOmpHost(pi, gateway !== undefined);

	const adopt = (ctx: ExtensionContext): void => {
		if (ctx.agent.kind !== "main") return;
		const sessionId = ctx.sessionManager.getSessionId();
		// Tree navigation changes the leaf, not admission identity. Keep its correlated response authenticated.
		if (boundSession === sessionId) { omp.refreshContext(ctx); return; }
		boundSession = sessionId;
		bridge?.invalidateAuthentication();
		omp.adopt(ctx);
        bridge ??= startBridge({ dir, token, host: omp.host, gateway });
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
