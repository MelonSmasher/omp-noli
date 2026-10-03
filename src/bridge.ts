import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Socket, SocketListener } from "bun";
import {
	type AgentOutputParams,
	type AgentOutputResult,
	type AgentView,
	type Capabilities,
	type CancelWorkResult,
	type CapabilityName,
	type CapabilityReason,
	type DefinitionView,
	type ErrorBody,
	type ErrorCode,
	type HelloResult,
	type KillResult,
	type ListResult,
	PROTOCOL_VERSION,
	type ServerFrame,
	type TurnResult,
	type WorkResult,
} from "./protocol";

/** Transport: newline-delimited JSON over a private Unix socket. Wire types live in ./protocol. */
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PREAUTH_BYTES = 4096;
const MAX_TEXT_BYTES = 256 * 1024;

/** Everything the bridge needs from the agent runtime, expressed in protocol vocabulary. */
export interface BridgeHost {
	sessionId(): string;
	/** Current capability snapshot; the bridge refuses methods whose capability is unavailable. */
	capabilities(): Capabilities;
	/** Re-probe host shapes now (cheap) and return the fresh snapshot. */
	refreshCapabilities(): Capabilities;
	/** Subscribe to capability changes. */
	onCapabilitiesChanged(listener: (capabilities: Capabilities) => void): () => void;
	/** Agents of the current root session. When `includePersisted`, first ask the host to restore children left by earlier processes. */
	list(options: { includePersisted: boolean }): Promise<ListResult>;
	/** Read visible child transcript pages without reviving the child. */
	output(params: AgentOutputParams): Promise<AgentOutputResult>;
	subscribe(listener: (agent: AgentView) => void): () => void;
	/** Agent definitions `agents.turn` accepts. */
	definitions(): Promise<DefinitionView[]>;
	/** Queue an interrupting message on a LIVE agent. */
	steer(id: string, text: string): Promise<void>;
	/** Queue a message processed after the agent would otherwise stop; LIVE agent only. */
	followUp(id: string, text: string): Promise<void>;
	/** Revive if parked, then run one monitored turn with the named definition. */
	turn(id: string, text: string, definition: string): Promise<TurnResult>;
	/** Abort and terminally release a LIVE agent. Returns false if there is nothing to kill. */
	killLive(id: string): Promise<boolean>;
	/** Terminally release a PARKED agent without executing a turn; persists the host's tombstone. */
	killParked(id: string): Promise<boolean>;
	/** The root session's observed settlement state and running background jobs. */
	work(): WorkResult;
	/** Cancel an owned job and await its body/cleanup. False if already finished or not owned. */
	cancelJob(id: string): Promise<boolean>;
}

export class BridgeError extends Error {
	readonly body: ErrorBody;
	constructor(code: ErrorCode, message: string, extra?: { capability: CapabilityName; reason: CapabilityReason }) {
		super(message);
		this.body = { code, message, ...extra };
	}
}

interface ConnectionState {
	buffer: Buffer;
	authed: boolean;
	closed: boolean;
	outbound: Buffer;
	authenticatedSession?: string;
}

export interface BridgeOptions {
	/** Directory that will contain the socket. Created 0700; must be owned by us and inaccessible to others. */
	dir: string;
	/** Shared secret the launching app passes through the environment. */
	token: string;
	host: BridgeHost;
}

export interface Bridge {
	socketPath: string;
	close(): void;
	/** Only a successful hello for this adoption authorizes agent-facing control. */
	hasAuthenticatedSession(sessionId: string): boolean;
	invalidateAuthentication(): void;
}

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

function tokenMatches(expected: string, supplied: unknown): boolean {
	if (typeof supplied !== "string") return false;
	return timingSafeEqual(digest(expected), digest(supplied));
}

function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`bridge dir ${dir} is not a real directory`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`bridge dir ${dir} is not owned by the current user`);
	}
	if ((stat.mode & 0o077) !== 0) throw new Error(`bridge dir ${dir} must not be accessible to group/other (mode ${(stat.mode & 0o777).toString(8)})`);
}

type Params = Record<string, unknown>;

function paramString(params: Params, key: string, maxBytes = 512): string {
	const value = params[key];
	if (typeof value !== "string" || value.length === 0) throw new BridgeError("bad_request", `params.${key} must be a non-empty string`);
	if (Buffer.byteLength(value) > maxBytes) throw new BridgeError("bad_request", `params.${key} exceeds ${maxBytes} bytes`);
	return value;
}

function optionalString(params: Params, key: string): string | undefined {
	return params[key] === undefined ? undefined : paramString(params, key);
}

export function startBridge(options: BridgeOptions): Bridge {
	const { host, token } = options;
	ensurePrivateDir(options.dir);
	const socketPath = join(options.dir, `omp-${process.pid}.sock`);
	// Refuse collisions rather than unlinking an existing endpoint we do not own.

	const sockets = new Set<Socket<ConnectionState>>();
	const turnsInFlight = new Set<string>();

	const flush = (socket: Socket<ConnectionState>): void => {
		if (socket.data.closed || !socket.data.outbound.length) return;
		const written = socket.write(socket.data.outbound);
		socket.data.outbound = socket.data.outbound.subarray(written);
	};
	const send = (socket: Socket<ConnectionState>, frame: ServerFrame): void => {
		if (socket.data.closed) return;
		const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
		if (socket.data.outbound.length + bytes.length > 8 * MAX_FRAME_BYTES) {
			socket.terminate();
			return;
		}
		socket.data.outbound = Buffer.concat([socket.data.outbound, bytes]);
		flush(socket);
	};

	const requireCapability = (name: CapabilityName): void => {
		const state = host.capabilities()[name];
		if (!state.available) {
			throw new BridgeError("capability_unavailable", `${name} is unavailable on this OMP host: ${state.detail}`, { capability: name, reason: state.reason });
		}
	};

	const requireChild = async (id: string): Promise<AgentView> => {
		const view = (await host.list({ includePersisted: false })).agents.find(a => a.id === id);
		if (!view) throw new BridgeError("unknown_agent", `no agent "${id}" in this session`);
		if (view.kind !== "sub") throw new BridgeError("forbidden_kind", `agent "${id}" is ${view.kind}; only subagents can be controlled`);
		return view;
	};

	const dispatch = async (method: string, params: Params): Promise<unknown> => {
		switch (method) {
			case "capabilities.get":
				return { capabilities: host.refreshCapabilities() };
			case "definitions.list": {
				requireCapability("definitions.list");
				return { definitions: await host.definitions() };
			}
			case "agents.list": {
				requireCapability("agents.list");
				const persisted = params.persisted;
				if (persisted !== undefined && typeof persisted !== "boolean") throw new BridgeError("bad_request", "params.persisted must be a boolean");
				// An explicit persisted:true is a demand; the default is best effort and never fails the listing.
				if (persisted === true) requireCapability("agents.list.persisted");
				const includePersisted = persisted ?? host.capabilities()["agents.list.persisted"].available;
				return host.list({ includePersisted }) satisfies Promise<ListResult>;
			}
			case "agents.output": {
				requireCapability("agents.output");
				const agentId = paramString(params, "agentId");
				const { offset, limit } = params;
				if (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)) {
					throw new BridgeError("bad_request", "params.offset must be a non-negative safe integer");
				}
				if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)) {
					throw new BridgeError("bad_request", "params.limit must be an integer from 1 to 500");
				}
				return host.output({ agentId, offset: offset as number | undefined, limit: limit as number | undefined });
			}
			case "agents.steer":
			case "agents.followUp": {
				requireCapability(method);
				const view = await requireChild(paramString(params, "agentId"));
				const text = paramString(params, "text", MAX_TEXT_BYTES);
				if (view.state === "terminated") throw new BridgeError("already_terminal", `agent "${view.id}" is terminated`);
				if (!view.live) throw new BridgeError("parked", `agent "${view.id}" is not live; use agents.turn to revive it`);
				if (method === "agents.steer") await host.steer(view.id, text);
				else await host.followUp(view.id, text);
				return { queued: true };
			}
			case "agents.turn": {
				requireCapability("agents.turn");
				const view = await requireChild(paramString(params, "agentId"));
				if (view.state === "terminated") throw new BridgeError("already_terminal", `agent "${view.id}" is terminated`);
				const text = paramString(params, "text", MAX_TEXT_BYTES);
				const definition = optionalString(params, "agent") ?? view.definition;
				if (!definition) {
					throw new BridgeError("definition_required", `agent "${view.id}" has no recorded definition; pass params.agent (see definitions.list)`);
				}
				if (turnsInFlight.has(view.id)) throw new BridgeError("busy", `a bridge turn is already running on "${view.id}"`);
				turnsInFlight.add(view.id);
				try {
					return (await host.turn(view.id, text, definition)) satisfies TurnResult;
				} finally {
					turnsInFlight.delete(view.id);
				}
			}
			case "agents.kill": {
				const view = await requireChild(paramString(params, "agentId"));
				if (view.state === "terminated") throw new BridgeError("already_terminal", `agent "${view.id}" is already terminated`);
				if (turnsInFlight.has(view.id) && !view.live) throw new BridgeError("busy", `"${view.id}" is being revived by a bridge turn`);
				if (view.live) {
					requireCapability("agents.kill.live");
					return { killed: await host.killLive(view.id), mode: "live" } satisfies KillResult;
				}
				requireCapability("agents.kill.parked");
				return { killed: await host.killParked(view.id), mode: "parked" } satisfies KillResult;
			}
			case "work.get": {
				requireCapability("work.get");
				return host.work() satisfies WorkResult;
			}
			case "work.cancel": {
				requireCapability("work.cancel");
				return { cancelled: await host.cancelJob(paramString(params, "jobId")) } satisfies CancelWorkResult;
			}
			default:
				throw new BridgeError("unknown_method", `unknown method "${method}"`);
		}
	};

	const handleFrame = async (socket: Socket<ConnectionState>, line: string): Promise<void> => {
		if (socket.data.closed) return;
		/** Before authentication, any malformed frame ends the connection, same as a failed hello. */
		const closeIfUnauthed = (): void => {
			if (socket.data.authed) return;
			socket.data.closed = true;
			socket.end();
		};
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			send(socket, { type: "response", id: null, ok: false, error: { code: "bad_frame", message: "frame is not valid JSON" } });
			closeIfUnauthed();
			return;
		}
		const record = frame && typeof frame === "object" && !Array.isArray(frame) ? (frame as Params) : undefined;
		const id = typeof record?.id === "string" || typeof record?.id === "number" ? record.id : null;
		const fail = (error: ErrorBody): void => send(socket, { type: "response", id, ok: false, error });

		if (!record) {
			fail({ code: "bad_frame", message: "frame must be an object" });
			closeIfUnauthed();
			return;
		}

		if (!socket.data.authed) {
			const helloParams = record.params && typeof record.params === "object" && "token" in record.params ? record.params : undefined;
			if (record.method !== "hello" || !tokenMatches(token, helloParams?.token)) {
				fail({ code: "unauthorized", message: "hello with a valid token is required" });
				socket.data.closed = true;
				socket.end();
				return;
			}
			socket.data.authed = true;
			socket.data.authenticatedSession = host.sessionId();
			const hello: HelloResult = { protocol: PROTOCOL_VERSION, sessionId: host.sessionId(), pid: process.pid, capabilities: host.refreshCapabilities() };
			send(socket, { type: "response", id, ok: true, result: hello });
			return;
		}

		if (typeof record.method !== "string") return fail({ code: "bad_request", message: "method must be a string" });
		if (socket.data.authenticatedSession !== host.sessionId() || record.sessionId !== host.sessionId()) {
			return fail({ code: "stale_session", message: "connection or request targets a different session; authenticate again" });
		}
		try {
			const params = record.params && typeof record.params === "object" && !Array.isArray(record.params) ? (record.params as Params) : {};
			const result = await dispatch(record.method, params);
			if (socket.data.authenticatedSession !== host.sessionId() || record.sessionId !== host.sessionId()) {
				throw new BridgeError("stale_session", "session changed while the request was running");
			}
			send(socket, { type: "response", id, ok: true, result });
		} catch (error) {
			if (error instanceof BridgeError) fail(error.body);
			else fail({ code: "internal", message: error instanceof Error ? error.message : String(error) });
		}
	};

	const broadcast = (frame: (sessionId: string) => ServerFrame): void => {
		const sessionId = host.sessionId();
		for (const socket of sockets) {
			if (socket.data.authed && socket.data.authenticatedSession === sessionId) send(socket, frame(sessionId));
		}
	};
	const unsubscribeAgents = host.subscribe(agent => broadcast(sessionId => ({ type: "event", event: "agent.changed", sessionId, agent })));
	const unsubscribeCapabilities = host.onCapabilitiesChanged(capabilities =>
		broadcast(sessionId => ({ type: "event", event: "capabilities.changed", sessionId, capabilities })),
	);

	const listener: SocketListener<ConnectionState> = Bun.listen<ConnectionState>({
		unix: socketPath,
		socket: {
			open(socket) {
				socket.data = { buffer: Buffer.alloc(0), outbound: Buffer.alloc(0), authed: false, closed: false };
				sockets.add(socket);
			},
			drain: flush,
			data(socket, chunk) {
				const state = socket.data;
				state.buffer = Buffer.concat([state.buffer, chunk]);
				for (;;) {
					const newline = state.buffer.indexOf(0x0a);
					if (newline === -1) break;
					const limit = state.authed ? MAX_FRAME_BYTES : MAX_PREAUTH_BYTES;
					if (newline > limit) {
						send(socket, { type: "response", id: null, ok: false, error: { code: "frame_too_large", message: `frame exceeds ${limit} bytes` } });
						socket.end();
						return;
					}
					const line = state.buffer.subarray(0, newline).toString("utf8");
					state.buffer = state.buffer.subarray(newline + 1);
					if (line.trim().length > 0) void handleFrame(socket, line);
					if (state.closed) return;
				}
				const limit = state.authed ? MAX_FRAME_BYTES : MAX_PREAUTH_BYTES;
				if (state.buffer.length > limit) {
					send(socket, { type: "response", id: null, ok: false, error: { code: "frame_too_large", message: `frame exceeds ${limit} bytes` } });
					socket.end();
				}
			},
			close(socket) {
				socket.data.closed = true;
				sockets.delete(socket);
			},
			error(socket) {
				socket.data.closed = true;
				sockets.delete(socket);
			},
		},
	});
	chmodSync(socketPath, 0o600);

	return {
		socketPath,
		hasAuthenticatedSession(sessionId) {
			for (const socket of sockets) {
				if (!socket.data.closed && socket.data.authed && socket.data.authenticatedSession === sessionId) return true;
			}
			return false;
		},
		invalidateAuthentication() {
			for (const socket of sockets) socket.data.authenticatedSession = undefined;
		},
		close() {
			unsubscribeAgents();
			unsubscribeCapabilities();
			for (const socket of sockets) socket.end();
			sockets.clear();
			listener.stop(true);
			try {
				unlinkSync(socketPath);
			} catch {
				// already removed
			}
		},
	};
}
