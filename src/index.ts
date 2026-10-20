import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Bridge, startBridge } from "./bridge";
import { installImagePublisher } from "./images";
import { createOmpHost } from "./omp-host";
import { installThreadControl } from "./thread-control";
import { bindForgeRoot, installForgeRelay, releaseForgeRoot } from "./forge-relay";
import { consumePrivateFile } from "./windows-native";
import { registerGateway, rejoinGateway } from "./gateway";

/** Set by the launcher; a directory and bootstrap input enable Bridge and Gateway setup. */
export const ENV_DIR = "NOLI_BRIDGE_DIR";
export const ENV_TOKEN_FILE = "NOLI_BRIDGE_TOKEN_FILE";

/** The launch environment contains only a path; Bun children cannot inherit secret bytes. */
function consumeBootstrap(path: string): string {
	// Windows reports mode 0666 for every file; there the owner and DACL decide, checked through the opened handle.
	if (process.platform === "win32") return consumePrivateFile(path);
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
	const dir = process.env[ENV_DIR];
	const tokenFile = process.env[ENV_TOKEN_FILE];
	const legacyToken = process.env.NOLI_BRIDGE_TOKEN;
	delete process.env[ENV_TOKEN_FILE];
	delete process.env.NOLI_BRIDGE_TOKEN;
	// A subagent of the bound root re-runs this factory after the bootstrap was consumed; it only needs the Gateway models.
	// It also reaches its root's Noli forge tools through the relay, under the root's authority.
	if (!dir || (!tokenFile && !legacyToken)) { rejoinGateway(pi, dir); installForgeRelay(pi, dir); return; }
	if (!tokenFile && existsSync(join(dir, "gateway-providers.json"))) {
		throw new Error("Noli gateway binding requires NOLI_BRIDGE_TOKEN_FILE");
	}
	// Root sessions only: subagents use the relay's own guard, never these host-tool hooks.
	installThreadControl(pi, sessionId => bridge?.authenticatedGeneration(sessionId), dir);
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
		// Subagents reach only this session's genuine RPC host tools; a new session replaces the root.
		const registry = (pi as unknown as { pi?: { AgentRegistry?: { global(): { get(id: string): { session?: unknown } | undefined } } } }).pi?.AgentRegistry;
		const agentId = ctx.agent.id;
		bindForgeRoot({ dir, sessionId, generation: id => bridge?.authenticatedGeneration(id), tool(name) {
			const session = registry?.global().get(agentId)?.session as { hasRpcHostTool?(name: string): boolean; getToolByName?(name: string): unknown } | undefined;
			return session?.hasRpcHostTool?.(name) ? session.getToolByName?.(name) as never : undefined;
		} });
	};

	pi.on("session_start", (_event, ctx) => adopt(ctx));
	pi.on("session_switch", (_event, ctx) => adopt(ctx));
	pi.on("session_branch", (_event, ctx) => adopt(ctx));
	pi.on("session_tree", (_event, ctx) => adopt(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent.kind !== "main" || ctx.sessionManager.getSessionId() !== boundSession) return;
		bridge?.close();
		bridge = undefined;
		releaseForgeRoot(dir);
		boundSession = undefined;
		omp.release();
	});
}
