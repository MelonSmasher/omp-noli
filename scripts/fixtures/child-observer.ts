import { createServer, type Server, type Socket } from "node:net";
import type { AgentRef, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type HeldGate = { resolve(): void; reject(error: Error): void };
const stateKey = Symbol.for("omp-noli.child-smoke.held-gates");
const fixtureGlobal = globalThis as typeof globalThis & { [stateKey]?: Map<string, HeldGate> };

/** Test instrumentation only: reads native state and holds one genuine extension tool. */
export default function childObserver(pi: ExtensionAPI): void {
	const registry = pi.pi.AgentRegistry.global();
	const identities = new WeakMap<object, number>();
	let serial = 0;
	const identity = (ref: object) => {
		let value = identities.get(ref);
		if (value === undefined) identities.set(ref, value = ++serial);
		return value;
	};
	const retained = new Map<string, unknown>();
	// Native children initialize their own extension instances in the same process.
	const gates = fixtureGlobal[stateKey] ??= new Map<string, HeldGate>();
	const sockets = new Set<Socket>();
	let rootId: string | undefined;
	let server: Server | undefined;
	let unsubscribe: (() => void) | undefined;
	const snapshot = (ref: AgentRef) => {
		const session = ref.session;
		return {
			id: ref.id, identity: identity(ref), kind: ref.kind, parentId: ref.parentId ?? null,
			status: ref.status, live: session !== null, sessionFile: ref.sessionFile,
			createdAt: ref.createdAt, lastActivity: ref.lastActivity, lifecycle: ref.lifecycle ?? null,
			history: ref.history ?? null,
			native: session ? {
				messages: session.messages,
				streamMessage: session.agent.state.streamMessage ?? null,
				entries: session.sessionManager.getBranch(),
				stats: session.getSessionStats(),
				servingModel: session.servingModel ?? null,
				configuredThinking: session.configuredThinkingLevel() ?? null,
				thinkingLevel: session.thinkingLevel ?? null,
				context: session.getContextUsage() ?? null,
				tokenRate: session.tokenRate.rate(),
				streaming: session.isStreaming,
			} : null,
		};
	};
	pi.registerTool({
		name: "child_smoke_gate", label: "Child smoke gate", description: "Wait for the smoke client, then return its deterministic observation.",
		loadMode: "essential", approval: "read",
		parameters: pi.zod.object({ marker: pi.zod.string() }),
		async execute(_id, params, signal, _update, ctx) {
			if (ctx.agent.kind !== "sub") throw new Error("Smoke gate requires a native child");
			if (!params || typeof params !== "object" || !("marker" in params) || typeof params.marker !== "string") throw new Error("Invalid smoke marker");
			const held = Promise.withResolvers<void>();
			gates.set(ctx.agent.id, held);
			const abort = () => held.reject(new Error("Smoke gate aborted"));
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			try {
				await held.promise;
				return { content: [{ type: "text" as const, text: `CHILD TOOL RESULT ${params.marker} 🧪\nsecond result line` }], details: { marker: params.marker } };
			} finally {
				gates.delete(ctx.agent.id);
				signal?.removeEventListener("abort", abort);
			}
		},
	});
	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main" || server) return;
		rootId = ctx.agent.id;
		unsubscribe = registry.onChange(event => {
			if (event.ref.session) retained.set(event.ref.id, JSON.parse(JSON.stringify(snapshot(event.ref))));
		});
		server = createServer(socket => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.on("error", () => {});
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				buffer += chunk;
				for (;;) {
					const end = buffer.indexOf("\n");
					if (end < 0) break;
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					let request: { id?: string; op: string; agentId?: string } | undefined;
					try {
						const value: unknown = JSON.parse(line);
						if (!value || typeof value !== "object" || !("op" in value) || typeof value.op !== "string") throw new Error("Invalid observer request");
						request = { op: value.op, ...("id" in value && typeof value.id === "string" ? { id: value.id } : {}), ...("agentId" in value && typeof value.agentId === "string" ? { agentId: value.agentId } : {}) };
						if (request.op === "release") {
							const gate = gates.get(request.agentId ?? "");
							if (!gate) throw new Error("Native child tool is not held");
							gate.resolve();
							socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { released: true } })}\n`);
						} else if (request.op === "snapshot") {
							const refs = registry.list().filter(ref => ref.id === rootId || ref.parentId === rootId);
							const agents = refs.map(ref => {
								const current = snapshot(ref);
								if (ref.session) retained.set(ref.id, JSON.parse(JSON.stringify(current)));
								return { ...current, retained: retained.get(ref.id) ?? null, held: gates.has(ref.id) };
							});
							socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { rootId, agents } })}\n`);
						} else throw new Error("Unknown native observer operation");
					} catch (error) {
						socket.write(`${JSON.stringify({ id: request?.id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
					}
				}
			});
		});
		const path = process.env.CHILD_SMOKE_OBSERVER_SOCKET;
		if (!path) throw new Error("Native observer socket is not configured");
		server.listen(path);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		unsubscribe?.();
		for (const gate of gates.values()) gate.reject(new Error("Smoke observer shutdown"));
		for (const socket of sockets) socket.destroy();
		server?.close();
	});
}
