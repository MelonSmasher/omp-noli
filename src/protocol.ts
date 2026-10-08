/**
 * Noli bridge wire protocol, version 1.
 *
 * This module is the contract Noli consumes. It has no transport code and no
 * OMP imports: every value here is Noli-facing vocabulary, and the OMP adapter
 * maps host data onto it. `protocol/noli-bridge.schema.json` is the
 * language-neutral form of the same contract; tests validate every frame the
 * bridge emits against it.
 *
 * Every enum is closed. A host value the adapter doesn't recognize is mapped to
 * `unknown` instead of being passed through, so a new OMP state can't reach
 * Noli as an unexpected string.
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- capabilities

export const CAPABILITY_NAMES = [
    "gateway.bind",
	"agents.list",
	"host.thread_read",
	"host.thread_open",
	"agents.list.persisted",
	"agents.output",
	"agents.steer",
	"agents.followUp",
	"agents.turn",
	"agents.kill.live",
	"agents.kill.parked",
	"definitions.list",
	"work.get",
	"work.cancel",
	"host.attach_file",
	"tree.navigate",
	"goal.budget",
	"memory.status",
	"memory.search",
	"memory.save",
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/** Why a capability is unavailable. Stable codes; `detail` is human-readable only. */
export const CAPABILITY_REASONS = [
	/** A required host export is missing. */
	"export_missing",
	/** A required built-in tool isn't registered (e.g. OMP started with `--no-tools`). */
	"tool_missing",
	/** A host object no longer has the shape the internal hook expects. */
	"hook_changed",
	/** The hook passed its shape check but misbehaved when used. */
	"runtime_failure",
	/** No top-level session yet. */
	"not_ready",
] as const;
export type CapabilityReason = (typeof CAPABILITY_REASONS)[number];

export type CapabilityState =
	| { available: true; api: "public" | "internal" | "main-only-v1" | "main-only-v2"; detail: string }
	| { available: false; api: "public" | "internal" | "main-only-v1" | "main-only-v2"; reason: CapabilityReason; detail: string };

export type Capabilities = Record<CapabilityName, CapabilityState>;

/** Supplemental methods are negotiated individually; unsupported upstream APIs are not capabilities. */
export const NATIVE_METHODS = ["tree.navigate", "goal.budget", "memory.status", "memory.search", "memory.save"] as const;
export type NativeMethod = (typeof NATIVE_METHODS)[number];
export const UNAVAILABLE_NATIVE_METHODS = ["memory.clear", "memory.enqueue", "memory.stats", "memory.diagnose", "memory.queue", "plan.propose", "plan.approve", "mcp.control", "lsp.control", "dap.control", "input.secret"] as const;
export interface NavigateTreeParams { targetId: string; summarize?: boolean }
export interface GoalBudgetParams { tokenBudget: number | null }
export interface MemorySearchParams { query: string; limit?: number }
export interface MemorySaveParams { content: string; context?: string; source?: string; importance?: number }
/** Lossless official SDK result, including cancellation and backend-specific metadata. */
export interface NativeControlResult { cancelled?: boolean; backend?: string; goal?: unknown }


// ---------------------------------------------------------------------- agents

export const AGENT_KINDS = ["main", "sub", "advisor", "unknown"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * Agent lifecycle, independent of the host's own status names.
 * - `running`: executing a turn.
 * - `idle`: live, waiting for input.
 * - `parked`: not in memory; revivable with `agents.turn`.
 * - `terminated`: killed; cannot be revived.
 * - `unknown`: the host reported a state this bridge doesn't recognize.
 */
export const AGENT_STATES = ["running", "idle", "parked", "terminated", "unknown"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export interface AgentView {
	id: string;
	name: string;
	kind: AgentKind;
	parentId: string | null;
	state: AgentState;
	/** A live in-memory session is attached. */
	live: boolean;
	/** The live session is producing output right now. */
	streaming: boolean;
	/** Short display-only summary of current work. */
	activity: string | null;
	/** Name of the agent definition this agent runs, when the host recorded it (see `definitions.list`). */
	definition: string | null;
	/** Independently observed session telemetry; unavailable values stay null. */
	model: string | null;
	effort: string | null;
	requests: number | null;
	contextTokens: number | null;
	contextWindow: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	sessionCost: number | null;
	tokensPerSecond: number | null;
	/** Milliseconds since the Unix epoch. */
	createdAt: number;
	/** Milliseconds since the Unix epoch. */
	lastActivity: number;
}

// ------------------------------------------------------------------- discovery

export const DISCOVERY_STATUSES = ["complete", "skipped", "inconclusive", "unavailable", "none", "not_requested"] as const;
export type DiscoveryStatus = (typeof DISCOVERY_STATUSES)[number];

/** Why some persisted children are still unregistered, when the status explains it. */
export const DISCOVERY_REASONS = [
	/** The host scanned and declined some transcripts (stub, released, vibe-owned, or scanned before they completed). */
	"host_declined",
	/** Same as `host_declined`, from an earlier call; looked up again only when the transcript changes. */
	"previously_declined",
	/** No evidence the host scan ran. */
	"no_scan_evidence",
	/** The lookup call threw. */
	"lookup_failed",
	/** `agents.list.persisted` is unavailable; see `capabilities`. */
	"capability_unavailable",
	/** The session has no persisted root yet. */
	"no_root",
] as const;
export type DiscoveryReason = (typeof DISCOVERY_REASONS)[number];

export interface DiscoveryReport {
	status: DiscoveryStatus;
	reason: DiscoveryReason | null;
	detail: string;
	/** Children registered by this call. */
	restored: string[];
	/** Child transcripts found on disk that are still unregistered. */
	pending: string[];
}

export interface ListResult {
	agents: AgentView[];
	discovery: DiscoveryReport;
}

// ----------------------------------------------------------------- definitions

export const DEFINITION_SOURCES = ["bundled", "user", "project", "unknown"] as const;
export type DefinitionSource = (typeof DEFINITION_SOURCES)[number];

export interface DefinitionView {
	/** Pass as `agents.turn` `params.agent`. */
	name: string;
	description: string;
	source: DefinitionSource;
}

// ------------------------------------------------------------- method results

export interface AgentOutputParams {
	agentId: string;
	/** Exclusive upper line bound; omitted selects the newest page. */
	offset?: number;
	limit?: number;
}

export interface AgentOutputResult {
	agentId: string;
	text: string;
	/** Offsets into text are UTF-16 code units, not UTF-8 bytes. */
	spans: {
		id: string;
		role: string;
		tool: string | null;
		created_ms: number;
		start: number;
		end: number;
	}[];
	nextOffset: number | null;
}

export type AgentTelemetryView = Pick<AgentView,
	"model" | "effort" | "requests" | "contextTokens" | "contextWindow" |
	"inputTokens" | "outputTokens" | "sessionCost" | "tokensPerSecond">;

export interface TurnResult {
	output: string;
	exitCode: number | null;
	aborted: boolean;
}

export interface KillResult {
	killed: boolean;
	mode: "live" | "parked";
}

// ------------------------------------------------------------------------ work

/** Kind of background job, independent of the host's own names. */
export const JOB_KINDS = ["bash", "task", "eval", "unknown"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface JobView {
	id: string;
	kind: JobKind;
	/** Short display-only description of the job. */
	label: string;
	/** Milliseconds since the Unix epoch. */
	startedAt: number;
	/** The child agent the job runs, when it runs one. */
	agentId: string | null;
}

/**
 * Why the root session is or isn't settled. The host is settled only when it
 * is not streaming, has no admitted submission, nothing queued (`queued`
 * includes hidden next-turn messages the visible queues omit) and no pending
 * background work. Every field is observed, never inferred.
 */
export interface WorkResult {
	settled: boolean;
	streaming: boolean;
	admittedSubmission: boolean;
	/** Queued messages, including hidden next-turn messages. */
	queued: number;
	/** Of `queued`, messages hidden from queued-only user steering/follow-up chips; excludes live-steered chips. */
	hiddenQueued: number;
	/** Background work is pending: running jobs, undelivered results, or cancellation body/cleanup drain. */
	pendingAsyncWork: boolean;
	/** Running or cancellation-draining background jobs owned by the root session. */
	jobs: JobView[];
	/** Finished job results waiting to be delivered into the conversation. */
	undeliveredResults: number;
}

export interface CancelWorkResult {
	/** True only after an owned job was cancelled and its body/cleanup finished; false if finished or not owned. */
	cancelled: boolean;
}

export interface HelloResult {
	protocol: typeof PROTOCOL_VERSION;
	sessionId: string;
	pid: number;
	capabilities: Capabilities;
}
export interface GatewayBindParams { sessionId: string }
export interface GatewayBindResult { token: string; expires_ms: number }
export interface GatewayReadyResult { bound: boolean; /** Safe diagnostic while a working key is retained and renewal retries. */ renewalError?: string }
export interface GatewayBindRequest { type: "request"; id: string; method: "gateway.bind"; params: GatewayBindParams }

// ---------------------------------------------------------------------- errors

export const ERROR_CODES = [
	"unauthorized",
	"stale_session",
	"unknown_agent",
	"unknown_definition",
	"definition_required",
	"forbidden_kind",
	"parked",
	"already_terminal",
	"busy",
	"capability_unavailable",
	"bad_request",
	"bad_frame",
	"frame_too_large",
	"unknown_method",
	"not_ready",
	"internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
	code: ErrorCode;
	message: string;
	/** Present with `capability_unavailable`: which capability, and why. */
	capability?: CapabilityName;
	reason?: CapabilityReason;
}

// ---------------------------------------------------------------------- frames

export type RequestId = string | number;

export type ResponseFrame =
	| { type: "response"; id: RequestId | null; ok: true; result: unknown }
	| { type: "response"; id: RequestId | null; ok: false; error: ErrorBody };

export type EventFrame =
	| { type: "event"; event: "agent.changed"; sessionId: string; agent: AgentView }
	| { type: "event"; event: "capabilities.changed"; sessionId: string; capabilities: Capabilities };

export type ServerFrame = ResponseFrame | EventFrame | GatewayBindRequest;
