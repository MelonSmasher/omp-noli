/**
 * The only module that knows OMP. It maps OMP's registry, tools and transcript
 * layout onto the protocol vocabulary in ./protocol and implements BridgeHost.
 * Nothing OMP-shaped (paths, raw status strings, internal object names) crosses
 * into a protocol value except as human-readable `detail` text.
 */
import { readdirSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentRef, AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type BridgeHost, BridgeError } from "./bridge";
import { type Probe, available, probeJobCanceller, probeLifecycle, probeRosterReader, probeWork, unavailable } from "./capabilities";
import { readAgentOutput } from "./agent-output";
import { AgentTelemetry } from "./agent-telemetry";
import { nativeCapabilities, nativeControl } from "./native-controls";
import {
	type AgentKind,
	type AgentState,
	type AgentView,
	type AgentTelemetryView,
	type Capabilities,
	type CapabilityName,
	CAPABILITY_NAMES,
	type CapabilityState,
	type DefinitionSource,
	type DiscoveryReport,
	type JobKind,
	type WorkResult,
} from "./protocol";

/** OMP's subagent lifecycle channel (pi-tui session-observer-registry); carries the spawning definition name. */
const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

/** Upper bound on transcript directories walked when looking for undiscovered children. */
const MAX_SCAN_DIRS = 256;

/** Symbol description OMP uses to tag the registry with its per-root roster scan latches. */
const ROSTER_LATCH_SYMBOL = "persistedRosterLatches";

/** OMP agent status → protocol state. Unrecognized values become `unknown`, never pass through. */
const STATE_BY_OMP_STATUS: Record<string, AgentState> = { running: "running", idle: "idle", parked: "parked", aborted: "terminated" };
const KIND_BY_OMP_KIND: Record<string, AgentKind> = { main: "main", sub: "sub", advisor: "advisor" };
const SOURCE_BY_OMP_SOURCE: Record<string, DefinitionSource> = { bundled: "bundled", user: "user", project: "project" };
const JOB_KIND_BY_OMP_TYPE: Record<string, JobKind> = { bash: "bash", task: "task", eval: "eval" };

/**
 * A live session with queued messages (including hidden next-turn messages) is
 * still running work even between turns; otherwise OMP's registry status wins.
 * A main ref is never reported `running` from a stale registry status alone:
 * without streaming or queued input it is idle.
 */
function stateOf(ref: AgentRef): AgentState {
	if (ref.status === "aborted") return "terminated";
	const session = ref.session;
	if (session) {
		const queued = "queuedMessageCount" in session && typeof session.queuedMessageCount === "number" ? session.queuedMessageCount : 0;
		if (session.isStreaming || queued > 0) return "running";
		if (ref.kind === "main" && ref.status === "running") return "idle";
	}
	return STATE_BY_OMP_STATUS[ref.status] ?? "unknown";
}

interface Transcript {
	id: string;
	/** Changes when the file is rewritten; a changed transcript is worth another lookup. */
	stamp: string;
}

function toView(ref: AgentRef, definition: string | null, telemetry: AgentTelemetryView): AgentView {
	return {
		id: ref.id,
		name: ref.displayName,
		kind: KIND_BY_OMP_KIND[ref.kind] ?? "unknown",
		parentId: ref.parentId ?? null,
		state: stateOf(ref),
		live: ref.session !== null,
		streaming: ref.session?.isStreaming ?? false,
		activity: ref.activity ?? null,
		definition,
		...telemetry,
		createdAt: ref.createdAt,
		lastActivity: ref.lastActivity,
	};
}

/** Child transcripts under a root artifact dir, mirroring OMP's naming (skips advisors and backups). */
function childTranscripts(artifactRoot: string): Transcript[] {
	const found: Transcript[] = [];
	const pending = [artifactRoot];
	for (let visited = 0; visited < MAX_SCAN_DIRS; visited++) {
		const dir = pending.shift();
		if (dir === undefined) break;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		const dirs = new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.includes(".bak") || entry.name.startsWith("__advisor")) continue;
			const id = entry.name.slice(0, -".jsonl".length);
			const file = join(dir, entry.name);
			let stamp = "missing";
			try {
				const st = statSync(file);
				stamp = `${st.size}:${st.mtimeMs}`;
			} catch {
				// Vanished between readdir and stat; still a candidate, stamp marks it.
			}
			found.push({ id, stamp });
			if (dirs.has(id)) pending.push(join(dir, id));
		}
	}
	return found;
}

/**
 * Positive evidence that OMP's persisted-roster scan ran for `rootFile`: the
 * registry carries OMP's per-root latch map with an entry for this root.
 * Absence proves nothing (the scan may have failed and dropped its latch).
 */
function rosterScanRan(registry: object, rootFile: string): boolean {
	const symbol = Object.getOwnPropertySymbols(registry).find(s => s.description === ROSTER_LATCH_SYMBOL);
	if (!symbol) return false;
	const latches: unknown = Reflect.get(registry, symbol);
	if (!(latches instanceof Map)) return false;
	const wanted = resolve(rootFile);
	for (const key of latches.keys()) if (typeof key === "string" && resolve(key) === wanted) return true;
	return false;
}

export interface OmpHost {
	host: BridgeHost;
	/** Bind to a top-level session context; re-probes capabilities and warns. No-op for subagent contexts. */
	adopt(ctx: ExtensionContext): void;
	/** Refresh same-identity context without invalidating correlated native controls. */
	refreshContext(ctx: ExtensionContext): void;
	release(): void;
}

/** Adapt the owning OMP SDK session into bridge operations and probed capability policy. */
export function createOmpHost(pi: ExtensionAPI): OmpHost {
	const exportsRecord: Record<string, unknown> = pi.pi;
	const hasExport = (name: string): boolean => exportsRecord[name] !== undefined && exportsRecord[name] !== null;
	const { AgentRegistry, discoverAgents, finalizeSubagentLifecycle, runSubagentFollowUpTurn, USER_INTERRUPT_LABEL } = pi.pi;
	const registryOk = hasExport("AgentRegistry") && typeof AgentRegistry.global === "function";

	let current: ExtensionContext | undefined;
	let adoption = 0;
	let stopObservers: (() => void) | undefined;
	let warned = "";
	const capabilityListeners = new Set<(c: Capabilities) => void>();
	/** Verified behavioral failures; they override shape probes until the next session adoption. */
	let runtimeFailures: Partial<Record<CapabilityName, string>> = {};
	/** Transcripts OMP already declined to register, keyed `<root>\0<id>` → stamp. Retried when the stamp changes. */
	const declined = new Map<string, string>();
	/**
	 * Definition names OMP announced when spawning children in this process. OMP only fills
	 * `history.agent` for refs it reloads from disk, so live children need this.
	 *
	 * OMP registers the child's AgentRef just before it emits the start event, so the name is
	 * bound to that exact ref object. A reused id gets a new ref and never inherits the name,
	 * whether or not the event carries a transcript path, and entries vanish with their ref.
	 * Kept across session changes: a branch or tree navigation leaves the same children running.
	 */
	const spawnedDefinitions = new WeakMap<AgentRef, string>();
	/** Bridge-owned turns must share cancellation with terminal kill, including idle ownership waits. */
	const activeTurns = new Map<AgentRef, AbortController>();
	/** Native cancellation changes status before the body/finally drains. Keep that ownership visible. */
	const cancellingJobs = new Map<object, { session: unknown; job: WorkResult["jobs"][number]; completion: Promise<unknown> }>();
	const agentListeners = new Set<(agent: AgentView) => void>();
	const definitionOf = (ref: AgentRef): string | null => ref.history?.agent ?? spawnedDefinitions.get(ref) ?? null;

	const registry = () => AgentRegistry.global();
	const mainSession = (): unknown => (current && registryOk ? registry().get(current.agent.id)?.session : undefined);
	let telemetryTimer: ReturnType<typeof setInterval> | undefined;
	const telemetry = (): void => {
		try {
		const session = mainSession();
		if (!current || !session || typeof session !== "object") return;
		if ("getPrewalkState" in session && typeof session.getPrewalkState === "function") {
			const state = session.getPrewalkState();
			current.ui.setStatus("noli.prewalk", state ? `Prewalk armed → ${state.target?.name ?? state.target?.id ?? "implementation"}` : undefined);
		}
		if ("getSessionStats" in session && typeof session.getSessionStats === "function") {
			const stats = session.getSessionStats();
			current.ui.setStatus("noli.cost", typeof stats.cost === "number" && Number.isFinite(stats.cost) ? String(stats.cost) : undefined);
			for (const key of ["input", "output"] as const) {
				const value = stats.tokens?.[key];
				current.ui.setStatus(`noli.${key}`, typeof value === "number" && Number.isFinite(value) ? String(value) : undefined);
			}
		}
		// Read effective session layers, including project/CLI/runtime overrides, not global config.
		if ("settings" in session && session.settings && typeof session.settings === "object" && "rawValue" in session.settings && typeof session.settings.rawValue === "function") {
			const rawValue = session.settings.rawValue.bind(session.settings);
			const value = (id: string): unknown => rawValue({ id, segments: id.split("."), definition: { type: "number" } });
			const window = current.getContextUsage()?.contextWindow;
			const fixed = value("compaction.thresholdTokens");
			const percent = value("compaction.thresholdPercent");
			const reserve = value("compaction.reserveTokens");
			let threshold: number | undefined;
			if (window && "autoCompactionEnabled" in session && session.autoCompactionEnabled === true) {
				if (typeof fixed === "number" && Number.isFinite(fixed) && fixed > 0) threshold = Math.min(window - 1, Math.max(1, fixed));
				else if (typeof percent === "number" && Number.isFinite(percent) && percent > 0) threshold = Math.floor(window * Math.min(99, Math.max(1, percent)) / 100);
				else {
					const proportional = Math.max(1, Math.floor(window * .15));
					const configured = typeof reserve === "number" && Number.isFinite(reserve) ? reserve : undefined;
					const effective = Math.max(Math.floor(window * .15), configured ?? 16384);
					const budget = effective >= window || (configured === undefined && effective >= window - proportional) ? proportional : effective;
					threshold = Math.max(0, Math.min(window - 1, window - budget));
				}
			}
			current.ui.setStatus("noli.context-threshold", threshold === undefined || !window ? undefined : String(threshold / window * 100));
		}
		if ("tokenRate" in session && session.tokenRate && typeof session.tokenRate === "object" && "rate" in session.tokenRate && typeof session.tokenRate.rate === "function") {
			const rate = session.tokenRate.rate();
			current.ui.setStatus("noli.throughput", typeof rate === "number" && Number.isFinite(rate) ? String(rate) : undefined);
		}
		} catch (error) {
			// Optional status-line instrumentation must never interrupt root chat.
			pi.logger.warn("Noli root telemetry unavailable", { error: String(error) });
		}
	};

	const observeSpawn = (payload: unknown): void => {
		if (!registryOk || !payload || typeof payload !== "object" || !("id" in payload) || !("agent" in payload)) return;
		const { id, agent } = payload;
		if (typeof id !== "string" || typeof agent !== "string") return;
		const ref = registry().get(id);
		// No ref yet means this isn't the spawn we can bind to; never guess by id alone.
		if (!ref) return;
		if (spawnedDefinitions.get(ref) === agent) return;
		spawnedDefinitions.set(ref, agent);
		// The "registered" change went out before this event, without a definition. Push the corrected row once.
		if (scopedRef(id) === ref) publishAgent(ref);
	};

	const probeAll = (): Capabilities => {
		const session = mainSession();
		const noRegistry = unavailable("public", "export_missing", "pi.pi export missing: AgentRegistry");
		const publicCap = (names: string[], detail: string): CapabilityState => {
			if (!registryOk) return noRegistry;
			const absent = names.filter(n => !hasExport(n));
			return absent.length === 0
				? available("public", detail)
				: unavailable("public", "export_missing", `pi.pi export(s) missing: ${absent.join(", ")}`);
		};
		const queuedControlCap = (detail: string): CapabilityState => {
			const base = publicCap([], detail);
			if (!base.available) return base;
			if (!session || typeof session !== "object" || !("queuedMessageCount" in session) || typeof session.queuedMessageCount !== "number") {
				return unavailable("public", "hook_changed", "AgentSession.queuedMessageCount is required for safe queued child admission");
			}
			return base;
		};
		const internalCap = (name: CapabilityName, probe: (session: unknown) => Probe<unknown>): CapabilityState => {
			if (!registryOk) return noRegistry;
			const failure = runtimeFailures[name];
			if (failure) return unavailable("internal", "runtime_failure", failure);
			if (session === undefined) return unavailable("internal", "not_ready", "main session not established");
			const result = probe(session);
			return result.ok ? available("internal", result.detail) : unavailable("internal", result.reason, result.detail);
		};
		return {
			...nativeCapabilities(current, mainSession() as AgentSession | undefined),
			"host.thread_read": current && mainSession() ? available("main-only-v2", "Authenticated owning-main reference_id host tool; Noli authorizes durable submitted references") : unavailable("main-only-v2", "not_ready", "Main session not established"),
			"agents.list": publicCap([], "pi.pi.AgentRegistry"),
			"agents.list.persisted": internalCap("agents.list.persisted", probeRosterReader),
			"agents.output": (() => {
				const base = publicCap(["loadSessionMessagesReadOnly", "loadEntriesFromFile"], "AgentSession.messages + streamMessage; native read-only transcript and entry loaders (no writer or revival)");
				if (!base.available) return base;
				if (typeof exportsRecord.loadSessionMessagesReadOnly !== "function" || typeof exportsRecord.loadEntriesFromFile !== "function") return unavailable("public", "hook_changed", "loadSessionMessagesReadOnly and loadEntriesFromFile must be functions");
				return base;
			})(),
			"agents.steer": queuedControlCap("AgentSession.steer + queuedMessageCount"),
			"agents.followUp": queuedControlCap("AgentSession.followUp + queuedMessageCount"),
			"agents.turn": publicCap(["runSubagentFollowUpTurn", "discoverAgents"], "pi.pi.runSubagentFollowUpTurn"),
			"agents.kill.live": publicCap(["finalizeSubagentLifecycle", "USER_INTERRUPT_LABEL"], "AgentSession.abort + pi.pi.finalizeSubagentLifecycle"),
			"agents.kill.parked": internalCap("agents.kill.parked", probeLifecycle),
			"definitions.list": publicCap(["discoverAgents"], "pi.pi.discoverAgents"),
			"work.get": (() => {
				if (session === undefined) return unavailable("public", "not_ready", "main session not established");
				const probe = probeWork(session);
				return probe.ok ? available("public", probe.detail) : unavailable("public", probe.reason, probe.detail);
			})(),
			"work.cancel": internalCap("work.cancel", probeJobCanceller),
			"host.attach_file": available("main-only-v1", "Authenticated native host attachment calls are restricted to the owning main agent by installThreadControl"),
		};
	};
	let capabilities = probeAll();

	/** Warn for broken visible features; unsupported memory controls are silently omitted. */
	const warnUnavailable = (): void => {
		const down = CAPABILITY_NAMES.filter(n => !n.startsWith("memory.") && !capabilities[n].available);
		const signature = down.map(n => `${n}:${capabilities[n].detail}`).join("|");
		if (signature === warned) return;
		warned = signature;
		if (down.length === 0) return;
		const lines = down.map(n => {
			const state = capabilities[n];
			return `  - ${n} [${state.api}${state.available ? "" : `, ${state.reason}`}]: ${state.detail}`;
		});
		const message = `Noli bridge: ${down.length} capability(ies) DISABLED on OMP ${pi.pi.VERSION}; the Noli features that depend on them are switched off:\n${lines.join("\n")}`;
		pi.logger.warn("Noli bridge capabilities unavailable", { unavailable: Object.fromEntries(down.map(n => [n, capabilities[n]])) });
		process.stderr.write(`${message}\n`);
		current?.ui.notify(message, "warning");
	};

	/** Re-probe shapes (cheap) so a recovered or newly broken host is reflected, then publish and warn. */
	const refresh = (): Capabilities => {
		const next = probeAll();
		const changed = CAPABILITY_NAMES.some(n => next[n].available !== capabilities[n].available || next[n].detail !== capabilities[n].detail);
		capabilities = next;
		if (changed) for (const listener of capabilityListeners) listener(next);
		warnUnavailable();
		return next;
	};

	/** A verified behavioral failure (not an inconclusive observation): close the capability until the next adoption. */
	const fail = (name: CapabilityName, detail: string): void => {
		runtimeFailures = { ...runtimeFailures, [name]: detail };
		refresh();
	};

	const rootFile = (): string | undefined => current?.sessionManager.getSessionFile() ?? undefined;
	const artifactRoot = (): string | undefined => {
		const file = rootFile();
		return file ? resolve(file.replace(/\.jsonl$/, "")) : undefined;
	};

	const scopedRef = (id: string): AgentRef | undefined => {
		const ref = registry().get(id);
		if (!ref || !current) return undefined;
		if (ref.kind === "main") return ref.session?.sessionManager.getSessionId() === current.sessionManager.getSessionId() ? ref : undefined;
		const root = artifactRoot();
		if (!root || !ref.sessionFile) return undefined;
		return resolve(ref.sessionFile).startsWith(root + sep) ? ref : undefined;
	};

	const scopedRefs = (): AgentRef[] => registry().list().filter(ref => scopedRef(ref.id) === ref && (ref.kind !== "sub" || ownedChild(ref)));

	const within = (root: string, path: string): boolean => {
		const delta = relative(root, path);
		return delta !== "" && delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
	};
	const ownedChild = (ref: AgentRef): boolean => {
		if (!current || ref.kind !== "sub" || scopedRef(ref.id) !== ref) return false;
		const seen = new Set<AgentRef>();
		let ancestor: AgentRef | undefined = ref;
		while (ancestor?.kind === "sub" && !seen.has(ancestor)) {
			if (scopedRef(ancestor.id) !== ancestor) return false;
			seen.add(ancestor);
			ancestor = ancestor.parentId ? registry().get(ancestor.parentId) : undefined;
		}
		return ancestor?.kind === "main" && ancestor.id === current.agent.id && scopedRef(ancestor.id) === ancestor;
	};
	/** Native loaders get only canonical owned files, bounded before and after every asynchronous read. */
	const readChild = async <T>(ref: AgentRef, loader: (file: string) => Promise<T>): Promise<T> => {
		const ctx = current;
		const generation = adoption;
		const root = artifactRoot();
		const rootSession = ctx?.sessionManager.getSessionId();
		const file = ref.sessionFile;
		const session = ref.session;
		const check = (): void => {
			if (!ctx || current !== ctx || adoption !== generation || artifactRoot() !== root || current.sessionManager.getSessionId() !== rootSession || ref.sessionFile !== file || ref.session !== session || !ownedChild(ref)) {
				throw new BridgeError("stale_session", "child session, ownership or transcript changed during read");
			}
		};
		check();
		if (!root || !file) throw new BridgeError("unknown_agent", "child has no owned transcript");
		const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(file)]);
		check();
		if (!within(canonicalRoot, canonicalFile)) throw new BridgeError("unknown_agent", "child transcript escapes the root artifact directory");
		const before = await stat(canonicalFile);
		check();
		if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new BridgeError("bad_request", "child transcript must be a regular file of at most 64 MiB");
		let result: T;
		try {
			result = await loader(canonicalFile);
		} catch (error) {
			check();
			throw error;
		}
		check();
		const [afterRoot, afterFile, after] = await Promise.all([realpath(root), realpath(file), stat(canonicalFile)]);
		check();
		if (afterRoot !== canonicalRoot || afterFile !== canonicalFile || !within(afterRoot, afterFile) || before.dev !== after.dev || before.ino !== after.ino) {
			throw new BridgeError("stale_session", "canonical child transcript changed during read");
		}
		if (!after.isFile() || after.size > 64 * 1024 * 1024) throw new BridgeError("bad_request", "child transcript exceeds the 64 MiB persisted-input limit");
		return result;
	};
	const agentTelemetry = new AgentTelemetry(exportsRecord, readChild);
	const viewOf = (ref: AgentRef): AgentView => toView(ref, definitionOf(ref), agentTelemetry.sample(ref));
	const publishAgent = (ref: AgentRef): void => {
		if (!current || scopedRef(ref.id) !== ref || (ref.kind === "sub" && !ownedChild(ref))) return;
		const view = viewOf(ref);
		for (const listener of agentListeners) listener(view);
	};
	const startObservers = (): (() => void) => {
		const sessions = new Map<AgentRef, { session: NonNullable<AgentRef["session"]>; unsubscribe: () => void }>();
		const snapshots = new Map<AgentRef, string>();
		let closed = false;
		const publish = (ref: AgentRef): void => {
			if (closed || scopedRef(ref.id) !== ref || (ref.kind === "sub" && !ownedChild(ref))) return;
			const view = viewOf(ref);
			const signature = JSON.stringify(view);
			if (snapshots.get(ref) === signature) return;
			snapshots.set(ref, signature);
			for (const listener of agentListeners) listener(view);
		};
		const watch = (ref: AgentRef): void => {
			const prior = sessions.get(ref);
			if (prior?.session === ref.session) return;
			prior?.unsubscribe();
			sessions.delete(ref);
			if (ref.kind !== "sub" || !ownedChild(ref) || !ref.session || typeof ref.session.subscribe !== "function") return;
			const session = ref.session;
			const unsubscribe = session.subscribe(event => {
				if (closed || scopedRef(ref.id) !== ref || ref.session !== session || !ownedChild(ref)) return;
				// Snapshot completion boundaries before native parking drops the session.
				if (event.type === "message_end" || event.type === "agent_end" || event.type === "tool_execution_end") agentTelemetry.sample(ref);
				if (event.type !== "agent_end") return;
				void session.waitForIdle().then(() => publish(ref), error => {
					pi.logger.warn("Noli child idle observation failed", { id: ref.id, error: String(error) });
				});
			});
			sessions.set(ref, { session, unsubscribe });
		};
		const tick = (): void => {
			if (closed) return;
			try {
				for (const [ref, observed] of sessions) {
					if (scopedRef(ref.id) === ref && ownedChild(ref)) continue;
					observed.unsubscribe();
					sessions.delete(ref);
					snapshots.delete(ref);
				}
				for (const ref of scopedRefs()) { watch(ref); publish(ref); }
			} catch (error) {
				pi.logger.warn("Noli agent telemetry observation failed", { error: String(error) });
			}
		};
		const unsubscribeRegistry = registry().onChange(event => {
			if (!("ref" in event)) return;
			const ref = event.ref;
			if (event.type === "removed" || scopedRef(ref.id) !== ref || (ref.kind === "sub" && !ownedChild(ref))) {
				sessions.get(ref)?.unsubscribe();
				sessions.delete(ref);
				snapshots.delete(ref);
				return;
			}
			watch(ref);
			publish(ref);
		});
		const unsubscribeSpawn = pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, observeSpawn);
		tick();
		const timer = setInterval(tick, 250);
		return () => {
			closed = true;
			clearInterval(timer);
			unsubscribeRegistry();
			unsubscribeSpawn();
			for (const { unsubscribe } of sessions.values()) unsubscribe();
			sessions.clear();
			snapshots.clear();
		};
	};

	/**
	 * Have OMP restore this root's persisted children via the read tool's
	 * history:// lookup. Never throws for discovery outcomes: an unregistered
	 * transcript is normal (OMP skips header-only stubs, released one-shot
	 * children and vibe-owned children, and latches its scan per root), so only
	 * a missing hook shape disables the capability. Inconclusive runs are
	 * reported and retried on the next call.
	 */
	const discoverPersisted = async (): Promise<DiscoveryReport> => {
		const root = artifactRoot();
		const file = rootFile();
		if (!root || !file) return { status: "none", reason: "no_root", detail: "session has no persisted root yet", restored: [], pending: [] };
		const known = new Set(scopedRefs().map(ref => ref.id));
		const candidates = childTranscripts(root).filter(t => !known.has(t.id));
		if (candidates.length === 0) return { status: "none", reason: null, detail: "no unregistered child transcripts", restored: [], pending: [] };
		const key = (t: Transcript) => `${root}\0${t.id}`;
		const fresh = candidates.filter(t => declined.get(key(t)) !== t.stamp);
		if (fresh.length === 0) {
			return {
				status: "skipped",
				reason: "previously_declined",
				detail: "OMP previously declined these transcripts (stub, released, vibe-owned or scanned before they completed); retried when they change",
				restored: [],
				pending: candidates.map(t => t.id),
			};
		}
		const probe = probeRosterReader(mainSession());
		if (!probe.ok) {
			refresh();
			return { status: "unavailable", reason: "capability_unavailable", detail: probe.detail, restored: [], pending: candidates.map(t => t.id) };
		}
		let lookupError: string | undefined;
		try {
			// OMP runs the roster scan inside the lookup, before rendering; `:1` keeps the rendered output to one line.
			await probe.value.execute("noli-roster", { path: `history://${fresh[0]?.id}:1` });
		} catch (error) {
			lookupError = error instanceof Error ? error.message : String(error);
		}
		const after = new Set(scopedRefs().map(ref => ref.id));
		const restored = candidates.filter(t => after.has(t.id)).map(t => t.id);
		const remaining = candidates.filter(t => !after.has(t.id));
		const pending = remaining.map(t => t.id);
		const scanRan = restored.length > 0 || rosterScanRan(registry(), file);
		if (!scanRan) {
			// No positive evidence either way: keep the capability, retry next call.
			const detail = `history:// lookup gave no evidence that OMP scanned this root${lookupError ? ` (lookup error: ${lookupError})` : ""}; will retry`;
			pi.logger.warn("Noli persisted discovery inconclusive", { pending, lookupError });
			return { status: "inconclusive", reason: lookupError ? "lookup_failed" : "no_scan_evidence", detail, restored, pending };
		}
		for (const t of remaining) declined.set(key(t), t.stamp);
		if (remaining.length === 0) return { status: "complete", reason: null, detail: "all child transcripts registered", restored, pending: [] };
		return {
			status: "skipped",
			reason: "host_declined",
			detail: "OMP scanned this root and declined some transcripts (stub, released, vibe-owned or scanned before they completed)",
			restored,
			pending,
		};
	};

	const liveSession = (id: string) => {
		const session = scopedRef(id)?.session;
		if (!session) throw new BridgeError("parked", `agent "${id}" has no live session`);
		return session;
	};

	const requireNativeOwnership = (generation: number, ctx: ExtensionContext, session: AgentSession, message: string): void => {
		if (generation !== adoption || current?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId() || mainSession() !== session) throw new BridgeError("stale_session", message);
	};
	const nativeMutationTails = new WeakMap<AgentSession, Promise<void>>();
	const host: BridgeHost = {
		sessionId: () => {
			if (!current) throw new BridgeError("not_ready", "session context not established");
			return current.sessionManager.getSessionId();
		},
		capabilities: () => capabilities,
		onCapabilitiesChanged: listener => {
			capabilityListeners.add(listener);
			return () => capabilityListeners.delete(listener);
		},
		refreshCapabilities: refresh,
		nativeControl: async (method, params) => {
			const ctx = current;
			const session = mainSession() as AgentSession | undefined;
			const generation = adoption;
			if (!ctx || !session || session.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) throw new BridgeError("stale_session", "No owned root session");
			const capability = refresh()[method];
			if (!capability.available) throw new BridgeError("capability_unavailable", capability.detail, { capability: method, reason: capability.reason });
			const mutate = method === "tree.navigate" || method === "goal.budget";
			const previous = nativeMutationTails.get(session) ?? Promise.resolve();
			let release: (() => void) | undefined;
			if (mutate) nativeMutationTails.set(session, new Promise<void>(resolve => { release = resolve; }));
			try {
				if (mutate) await previous;
				requireNativeOwnership(generation, ctx, session, "Root session changed while native control awaited admission");
				if (mutate && [...cancellingJobs.values()].some(entry => entry.session === session)) throw new BridgeError("not_ready", "Owned background cancellation cleanup is still draining");
				const result = await nativeControl(method, params, ctx, session);
				requireNativeOwnership(generation, ctx, session, "Root session changed during native control; do not replay mutations");
				return result;
			} finally { release?.(); }
		},
		list: async ({ includePersisted }) => {
			const generation = adoption;
			if (!registryOk) {
				return {
					agents: [],
					discovery: { status: "unavailable", reason: "capability_unavailable", detail: "pi.pi export missing: AgentRegistry", restored: [], pending: [] },
				};
			}
			const discovery: DiscoveryReport = includePersisted
				? await discoverPersisted()
				: { status: "not_requested", reason: null, detail: "persisted discovery not requested", restored: [], pending: [] };
			if (generation !== adoption) throw new BridgeError("stale_session", "session changed during persisted discovery");
			const refs = scopedRefs();
			await Promise.all(refs.filter(ref => ref.kind === "sub" && !ref.session).map(ref => agentTelemetry.restore(ref)));
			if (generation !== adoption) throw new BridgeError("stale_session", "session changed during agent listing");
			return { agents: scopedRefs().map(viewOf), discovery };
		},
		output: async params => {
			const capability = refresh()["agents.output"];
			if (!capability.available) throw new BridgeError("capability_unavailable", capability.detail, { capability: "agents.output", reason: capability.reason });
			const ref = scopedRef(params.agentId);
			if (!ref) throw new BridgeError("unknown_agent", `no agent "${params.agentId}" in this session`);
			if (ref.kind !== "sub") throw new BridgeError("forbidden_kind", "only subagent transcripts can be read");
			if (!ownedChild(ref)) throw new BridgeError("unknown_agent", "child does not belong to this root session");
			return readChild(ref, () => readAgentOutput(ref, params, exportsRecord, readChild));
		},
		subscribe: listener => {
			agentListeners.add(listener);
			return () => agentListeners.delete(listener);
		},
		definitions: async () => {
			const { agents } = await discoverAgents(current?.cwd ?? process.cwd());
			return agents.map(a => ({ name: a.name, description: a.description, source: SOURCE_BY_OMP_SOURCE[a.source] ?? "unknown" }));
		},
		steer: async (id, text) => {
			await liveSession(id).steer(text);
			const ref = scopedRef(id);
			if (ref) publishAgent(ref);
		},
		followUp: async (id, text) => {
			await liveSession(id).followUp(text);
			const ref = scopedRef(id);
			if (ref) publishAgent(ref);
		},
		turn: async (id, text, definitionName) => {
			const ref = scopedRef(id);
			if (!ref) throw new BridgeError("unknown_agent", `no agent "${id}" in this session`);
			const { agents } = await discoverAgents(current?.cwd ?? process.cwd());
			const definition = agents.find(a => a.name === definitionName);
			if (!definition) throw new BridgeError("unknown_definition", `agent definition "${definitionName}" not found (see definitions.list)`);
			if (scopedRef(id) !== ref) throw new BridgeError("stale_session", "agent ownership changed during definition lookup");
			const controller = new AbortController();
			activeTurns.set(ref, controller);
			try {
				const result = await runSubagentFollowUpTurn({ id, agent: definition, message: text, signal: controller.signal });
				return { output: result.output, exitCode: result.exitCode, aborted: result.aborted === true };
			} finally {
				activeTurns.delete(ref);
			}
		},
		killLive: async id => {
			const ref = scopedRef(id);
			const session = ref?.session;
			if (!ref || !session) return false;
			activeTurns.get(ref)?.abort(USER_INTERRUPT_LABEL);
			await session.abort({ reason: USER_INTERRUPT_LABEL });
			await finalizeSubagentLifecycle({
				id,
				session,
				aborted: true,
				abortKind: "terminate",
				keepAlive: false,
				isolated: false,
				agentIdleTtlMs: 0,
				reviveSession: null,
			});
			return true;
		},
		killParked: async id => {
			const probe = probeLifecycle(mainSession());
			if (!probe.ok) {
				refresh();
				throw new BridgeError("capability_unavailable", `agents.kill.parked is unavailable: ${probe.detail}`, {
					capability: "agents.kill.parked",
					reason: probe.reason,
				});
			}
			const ref = scopedRef(id);
			if (!ref) throw new BridgeError("unknown_agent", `no agent "${id}" in this session`);
			if (ref.session) throw new BridgeError("busy", `agent "${id}" became live; retry agents.kill`);
			if (STATE_BY_OMP_STATUS[ref.status] === "terminated") throw new BridgeError("already_terminal", `agent "${id}" is already terminated`);
			if (!(await probe.value.release(id, ref, { tombstone: true }))) return false;
			const after = registry().get(id);
			if (after !== ref || STATE_BY_OMP_STATUS[after.status] !== "terminated" || after.session !== null) {
				const state = after ? `${STATE_BY_OMP_STATUS[after.status] ?? "unknown"}, live=${after.session !== null}` : "unregistered";
				fail("agents.kill.parked", `release() succeeded but the agent ended ${state}`);
				throw new BridgeError("internal", `agent "${id}" was released but did not reach a terminal state; verify before retrying`);
			}
			return true;
		},
		work: () => {
			const probe = probeWork(mainSession());
			if (!probe.ok) throw new BridgeError("capability_unavailable", `work.get is unavailable: ${probe.detail}`, { capability: "work.get", reason: probe.reason });
			const session = probe.value;
			// getQueuedMessages includes live-steered chips already removed from queuedMessageCount.
			// Count only user-authored messages still in the actual queues, matching OMP's predicate.
			let visibleQueued = 0;
			for (const queue of [session.agent.peekSteeringQueue(), session.agent.peekFollowUpQueue()]) {
				for (const message of queue) {
					if ((message.role === "user" && message.attribution !== "agent") || (message.role === "custom" && message.attribution === "user" && message.display !== false)) visibleQueued++;
				}
			}
			const snapshot = session.getAsyncJobSnapshot();
			const streaming = session.isStreaming;
			const admittedSubmission = session.hasAdmittedSubmission;
			const queued = session.queuedMessageCount;
			const draining = [...cancellingJobs.values()].filter(entry => entry.session === session);
			const pendingAsyncWork = session.hasPendingAsyncWork() || draining.length > 0;
			const result: WorkResult = {
				// OMP's own predicate, extended through native cancelled-job body/cleanup completion.
				settled: !streaming && !admittedSubmission && queued === 0 && !pendingAsyncWork,
				streaming,
				admittedSubmission,
				queued,
				hiddenQueued: Math.max(0, queued - visibleQueued),
				pendingAsyncWork,
				jobs: (snapshot?.running ?? []).map(job => ({
					id: job.id,
					kind: JOB_KIND_BY_OMP_TYPE[job.type] ?? "unknown",
					label: job.label,
					startedAt: job.startTime,
					agentId: job.agentId ?? null,
				})),
				undeliveredResults: snapshot?.delivery.queued ?? 0,
			};
			for (const { job } of draining) {
				if (!result.jobs.some(running => running.id === job.id)) result.jobs.push(job);
			}
			return result;
		},
		cancelJob: async id => {
			const session = mainSession();
			const probe = probeJobCanceller(session);
			if (!probe.ok) {
				refresh();
				throw new BridgeError("capability_unavailable", `work.cancel is unavailable: ${probe.detail}`, { capability: "work.cancel", reason: probe.reason });
			}
			const { manager, ownerId } = probe.value;
			const job = manager.getJob(id);
			if (!job || typeof job !== "object" || !("ownerId" in job) || job.ownerId !== ownerId) return false;
			const pending = cancellingJobs.get(job);
			if (pending) {
				await pending.completion;
				return true;
			}
			if (!("status" in job) || (job.status !== "running" && job.status !== "cancelled")) return false;
			if (!("promise" in job) || !job.promise || typeof job.promise !== "object" || !("then" in job.promise) || typeof job.promise.then !== "function" || !("type" in job) || typeof job.type !== "string" || !("label" in job) || typeof job.label !== "string" || !("startTime" in job) || typeof job.startTime !== "number") {
				fail("work.cancel", "getJob() exposes no observable job completion or job metadata; refusing cancellation");
				throw new BridgeError("capability_unavailable", "work.cancel cannot observe job termination", { capability: "work.cancel", reason: "hook_changed" });
			}
			const completion = Promise.resolve(job.promise as PromiseLike<unknown>);
			cancellingJobs.set(job, { session, completion, job: {
				id,
				kind: JOB_KIND_BY_OMP_TYPE[job.type] ?? "unknown",
				label: job.label,
				startedAt: job.startTime,
				agentId: "agentId" in job && typeof job.agentId === "string" ? job.agentId : null,
			} });
			try {
				// Native cancel returns false for an already-cancelled owned job,
				// whose body may still be draining; no await permits an owner race here.
				return manager.cancel(id, { ownerId });
			} finally {
				try {
					await completion;
				} finally {
					cancellingJobs.delete(job);
				}
			}
		},
	};

	return {
		host,
		refreshContext: ctx => {
			if (ctx.agent.kind !== "main" || !current || ctx.sessionManager.getSessionId() !== current.sessionManager.getSessionId()) return;
			current = ctx;
			refresh();
			telemetry();
		},
		adopt: ctx => {
			// Subagent sessions re-run session_start when revived; only the top-level session owns the bridge.
			if (ctx.agent.kind !== "main") return;
			adoption++;
			stopObservers?.();
			stopObservers = undefined;
			// Same-root branch/tree adoption keeps observed data on the actual refs.
			if (current?.sessionManager.getSessionFile() !== ctx.sessionManager.getSessionFile()) agentTelemetry.clear();
			current = ctx;
			runtimeFailures = {};
			declined.clear();
			refresh();
			clearInterval(telemetryTimer);
			telemetry();
			telemetryTimer = setInterval(telemetry, 1000);
			if (registryOk) stopObservers = startObservers();
		},
		release: () => {
			adoption++;
			stopObservers?.();
			stopObservers = undefined;
			agentTelemetry.clear();
			clearInterval(telemetryTimer);
			telemetryTimer = undefined;
			for (const key of ["prewalk", "cost", "input", "output", "context-threshold", "throughput"]) current?.ui.setStatus(`noli.${key}`, undefined);
			current = undefined;
			capabilities = probeAll();
		},
	};
}
