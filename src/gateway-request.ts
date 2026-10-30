import type { ProducerBranchParams, ProducerSessionParams, RequestFacts } from "./protocol";

function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Noli producer facts object");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !Object.hasOwn(record, key))) {
		throw new Error("Unsupported Noli producer facts shape");
	}
	return record;
}

function text(value: unknown, limit = 512): void {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > limit || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new Error("Invalid Noli producer facts string");
	}
}

function nullableText(value: unknown): void {
	if (value !== null) text(value);
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): void {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid Noli producer facts integer");
}

const COMPACTION_KINDS: readonly unknown[] = ["auto", "manual", "reactive"];

/** Validate the frozen protocol-2 producer contract (facts version 2) before it leaves the process. */
export function assertRequestFacts(value: unknown, requestClasses: readonly RequestFacts["requestClass"][]): asserts value is RequestFacts {
	const facts = object(value, ["version", "producerSessionId", "branchAnchor", "historyRevision", "producerAgentId", "parentProducerSessionId", "requestClass", "querySource", "firstEligible", "prompt"], ["previousMessageId", "prevToolDurations", "compactionKind", "contextCompacted"]);
	if (facts.version !== 2) throw new Error("Unsupported Noli producer facts version");
	text(facts.producerSessionId);
	text(facts.producerAgentId);
	nullableText(facts.parentProducerSessionId);
	nullableText(facts.branchAnchor);
	integer(facts.historyRevision, 0);
	if (!requestClasses.includes(facts.requestClass as RequestFacts["requestClass"])) throw new Error("Unsupported Noli request class");
	text(facts.querySource, 128);
	previousMessageId(facts.previousMessageId);
	if (facts.firstEligible !== null) firstEligible(facts.firstEligible);
	prompt(facts.prompt);
	if (facts.prevToolDurations !== undefined) {
		if (facts.requestClass === "compaction") throw new Error("Compaction requests carry no previous tool durations");
		prevToolDurations(facts.prevToolDurations);
	}
	// Every compaction is a native fork with its kind; the one-shot marker is main-only.
	if ((facts.requestClass === "compaction") !== (facts.compactionKind !== undefined)
		|| (facts.compactionKind !== undefined && !COMPACTION_KINDS.includes(facts.compactionKind))) throw new Error("Invalid Noli compaction kind");
	if (facts.contextCompacted !== undefined && (facts.requestClass !== "main" || !COMPACTION_KINDS.includes(facts.contextCompacted))) {
		throw new Error("Invalid Noli context-compacted kind");
	}
}

function previousMessageId(value: unknown): void {
	if (value !== undefined && (typeof value !== "string" || !/^msg_[A-Za-z0-9_-]{1,508}$/.test(value))) {
		throw new Error("Invalid Noli previous message id");
	}
}

function firstEligible(value: unknown): void {
	const first = object(value, ["messageId", "textBlockIndex", "sample"]);
	nullableText(first.messageId);
	if (first.textBlockIndex !== null) integer(first.textBlockIndex, 0);
	// Exactly three UTF-16 code units; lone surrogates were replaced by U+FFFD.
	if (typeof first.sample !== "string" || first.sample.length !== 3 || !first.sample.isWellFormed()) {
		throw new Error("Invalid Noli first-input sample");
	}
}

function prompt(value: unknown): void {
	const facts = object(value, ["id", "origin", "position"]);
	nullableText(facts.id);
	nullableText(facts.origin);
	if (facts.position === null) return;
	const position = object(facts.position, ["promptIndex", "turnIndex"]);
	integer(position.promptIndex, 0, 10_000_000);
	integer(position.turnIndex, 1, 10_000_000);
	if ((position.promptIndex as number) > (position.turnIndex as number)) throw new Error("Invalid Noli request turn position");
}

function prevToolDurations(value: unknown): void {
	if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error("Invalid Noli previous tool durations");
	for (const item of value) {
		const duration = object(item, ["toolName", "durationMs"]);
		text(duration.toolName);
		if (!(duration.toolName as string).isWellFormed()) throw new Error("Invalid Noli producer facts string");
		integer(duration.durationMs, 0);
	}
}

export function assertProducerSession(value: unknown): asserts value is ProducerSessionParams {
	const session = object(value, ["ompSessionId", "parentOmpSessionId", "agentKind", "agentId", "epochEntryId", "ompVersion", "systemPrefix"]);
	text(session.ompSessionId);
	nullableText(session.parentOmpSessionId);
	if (session.agentKind !== "main" && session.agentKind !== "sub") throw new Error("Unsupported Noli producer agent kind");
	if ((session.agentKind === "main") !== (session.parentOmpSessionId === null)) throw new Error("Noli producer parent does not match its agent kind");
	text(session.agentId);
	nullableText(session.epochEntryId);
	text(session.ompVersion, 64);
	if (session.systemPrefix !== null) {
		const prefix = object(session.systemPrefix, ["sha256", "len"]);
		if (typeof prefix.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(prefix.sha256)) throw new Error("Invalid Noli system prefix digest");
		integer(prefix.len, 1);
	}
}

export function assertProducerBranch(value: unknown): asserts value is ProducerBranchParams {
	const branch = object(value, ["ompSessionId", "leafId", "resetEntryIds"]);
	text(branch.ompSessionId);
	nullableText(branch.leafId);
	if (!Array.isArray(branch.resetEntryIds) || branch.resetEntryIds.length > 10_000) throw new Error("Invalid Noli reset entry list");
	for (const id of branch.resetEntryIds) text(id);
}

export function requestReference(value: unknown): { requestReference: string } {
	const result = object(value, ["requestReference"]);
	if (typeof result.requestReference !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.requestReference)) throw new Error("Invalid Noli request reference");
	return { requestReference: result.requestReference };
}
