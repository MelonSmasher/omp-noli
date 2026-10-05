import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const THREAD_TOOLS = ["noli_thread_get", "noli_thread_finish", "noli_attach_file"] as const;
const INSTRUCTION = "Authenticated Noli current-thread control is available. Read skill://noli before requesting deferred settle/archive; scheduled is not completed.";
const ATTACHMENT_INSTRUCTION = "Use authenticated noli_attach_file({path, caption?}) to copy a local file to persistent server storage and publish a downloadable conversation attachment; Markdown links alone do not attach files.";

/** No tools are registered here: Noli owns the single native RPC host-tool surface. */
export function installThreadControl(pi: ExtensionAPI, authenticated: (sessionId: string) => boolean): void {
	const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const available = (ctx: ExtensionContext, name?: string): boolean => authenticated(sessionId(ctx)) &&
		(name ? [name] : ["noli_thread_get", "noli_thread_finish"]).every(name =>
			pi.getAllTools().some(tool => tool.name === name && tool.sourceInfo.source === "sdk"));
	const calls = new Map<string, string>();
	pi.on("session_switch", () => calls.clear());
	pi.on("session_branch", () => calls.clear());
	pi.on("session_tree", () => calls.clear());
	pi.on("session_shutdown", () => calls.clear());
	pi.on("tool_call", (event, ctx) => {
		if (!THREAD_TOOLS.some(name => name === event.toolName)) return;
		if (ctx.agent.kind !== "main") return { block: true, reason: "Noli thread control is restricted to the owning session's main agent" };
		if (!available(ctx, event.toolName)) return { block: true, reason: "Authenticated Noli thread control is unavailable for this session" };
		const keys = Object.keys(event.input);
		const valid = event.toolName === "noli_thread_get" ? keys.length === 0 : event.toolName === "noli_attach_file"
			? keys.every(key => key === "path" || key === "caption") && typeof event.input.path === "string" && event.input.path.trim().length > 0 && (event.input.caption === undefined || typeof event.input.caption === "string")
			: keys.length === 1 && keys[0] === "action" && "action" in event.input && (event.input.action === "settle" || event.input.action === "archive");
		if (!valid) return { block: true, reason: "Invalid Noli host-tool arguments; only the owning current thread is permitted" };
		calls.set(event.toolCallId, sessionId(ctx));
	});
	pi.on("tool_result", (event, ctx) => {
		if (!THREAD_TOOLS.some(name => name === event.toolName)) return;
		const owner = calls.get(event.toolCallId);
		calls.delete(event.toolCallId);
		if (!event.isError && (owner !== sessionId(ctx) || !available(ctx, event.toolName))) {
			return { content: [{ type: "text", text: "Noli control acknowledgement lost its authenticated session; outcome unknown. The operation may already be persisted. Do not retry automatically; inspect the owning conversation before retrying." }], isError: true };
		}
		if (!event.isError && event.toolName === "noli_thread_finish") {
			const ack = event.details;
			if (!ack || typeof ack !== "object" || !("status" in ack) || ack.status !== "scheduled" || !("requestId" in ack) || typeof ack.requestId !== "string" || !ack.requestId || !("action" in ack) || !("action" in event.input) || ack.action !== event.input.action) {
				return { content: [{ type: "text", text: "Noli did not acknowledge scheduling this lifecycle request; outcome unknown, inspect Noli before retrying" }], isError: true };
			}
		}
		if (!event.isError && event.toolName === "noli_attach_file") {
			const ack = event.details;
			if (!ack || typeof ack !== "object" || !("status" in ack) || ack.status !== "attached" || !("attachmentId" in ack) || typeof ack.attachmentId !== "string" || !ack.attachmentId) {
				return { content: [{ type: "text", text: "Noli did not acknowledge storing this attachment; outcome unknown, inspect Noli before retrying" }], isError: true };
			}
		}
	});
	// Request-local policy, not a persisted message: no duplicate startup/resume/switch entries.
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const guidance = [];
		if (available(ctx)) guidance.push(INSTRUCTION);
		if (available(ctx, "noli_attach_file")) guidance.push(ATTACHMENT_INSTRUCTION);
		if (guidance.length === 0 && !event.systemPrompt.some(line => line === INSTRUCTION || line === ATTACHMENT_INSTRUCTION)) return;
		return { systemPrompt: [...event.systemPrompt.filter(line => line !== INSTRUCTION && line !== ATTACHMENT_INSTRUCTION), ...guidance] };
	});
}
