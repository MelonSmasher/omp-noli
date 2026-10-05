# omp-noli

An OMP extension that gives Noli a private local control channel. It runs next to native `omp --mode rpc-ui`. The primary session's conversation, history, dialogs, model controls and subscriptions stay on native RPC. This channel lists and controls the subagents (children) of the current root session. It is not the Noli GUI.

## Runtime and loading

Requires official OMP **18.5.1 or newer** and **Bun 1.4.2 or newer in the OMP runtime**; verified against OMP 18.5.1. No custom build is needed. Missing host APIs disable the affected capability with an explicit reason. Install development dependencies with `bun install`. Load the package root with `omp -e /path/to/omp-noli --mode rpc-ui`, or through the package's `omp.extensions` declaration.

Install release v0.3.2 with `omp plugin install github:MelonSmasher/omp-noli#v0.3.2`. Restart OMP sessions to load the updated extension. The package manifest reports `0.3.2`; protocol version 1 is unchanged. This release adds `agents.output` and nullable telemetry fields; clients with strict row/capability decoders must update to the bundled schema.

The launcher passes `NOLI_BRIDGE_DIR` and `NOLI_BRIDGE_TOKEN` in the child process environment. If either is missing, the extension does nothing. Use a fresh private directory for each OMP process and a cryptographically random token. Don't log the token or put it on the command line. The extension never writes the token to disk or sends it over RPC.

The directory is created with mode 0700. It is rejected if it is a symlink, isn't owned by the current user, or is accessible to group/other. The socket is `<dir>/omp-<pid>.sock`, mode 0600. The bridge never removes an existing endpoint at that path. On shutdown it closes clients, removes the socket and unsubscribes its listeners.

Only the top-level session starts the server; child sessions never open listeners. All runtime objects come from OMP itself: the host-injected `pi.pi` exports, the shared extension event bus, and the host's own built-in tool instances for the internal paths described below. Importing a second copy of OMP's runtime would control a different agent registry, so package dependencies are used for types only.

## Agent images

The authenticated owning main agent can call `noli_show_image({ source: "screenshots/result.png", caption: "Updated screen" })` to show a local image inline in Noli. `source` may also be an HTTP(S) image URL. Relative paths resolve in the agent's current working directory on its machine, including remote workspaces. Children and advisors return image paths or URLs to their parent rather than publishing directly.

Supported formats are PNG, JPEG, WebP and GIF, up to 5 MiB per image. The plugin bounds local/streaming download bytes, checks complete image containers and native pixel decoding, honors cancellation, and rechecks authenticated session ownership before submission. Native validation requires Bun.Image (Bun 1.4.2 or newer in the OMP runtime); an older runtime returns an explicit error.

The tool submits a displayed `noli.image` custom message with optional text and an image block `{ type: "image", data: "<base64>", mimeType: "image/png" }`. Busy sessions use noninterrupting `aside` delivery; idle submission does not start a model turn. Its acknowledgement is **submitted**, not proof of persistence or that the user has viewed it. Image bytes are not duplicated in the tool result. OMP may normalize large images before delivery and uses blob-backed native persistence.

**Companion Noli support is required:** translate displayed `noli.image` custom entries to assistant image/text blocks, retain image data through persistence/projection, and render image blocks inline with previews. Packaging, persistent installation and SSH transfer must include `src/images.ts`. This plugin release alone cannot make an older Noli UI display images. The socket bridge schema is unchanged.

## Agent downloadable files

The companion Noli server registers `noli_attach_file({ path: "report.pdf", caption: "Optional explanation" })` on the existing native host-tool surface. This plugin guards the call using trusted main-agent identity, SDK tool provenance and current-session socket authentication. `host.attach_file` advertises `available: true, api: "main-only-v1"`; older plugins do not enable this tool. Protocol version remains 1; consumers must accept this additive capability and API marker.

Noli retains any local regular file up to 100 MiB (including empty files) in server-owned storage and persists an attachment card before acknowledging `{ status: "attached", attachmentId: "..." }`. Relative paths resolve against the server-side thread workspace. The client downloads exact bytes through authenticated chunked transport and Save As; HTML is saved, not run inside Noli. The plugin rejects missing durable acknowledgements and child/advisor calls. Markdown links alone do not attach files.

This source change is not a published release. Production Noli requires a stable plugin release containing the gate and capability plus rebuilt server and desktop client; do not modify installed release archives to bypass provenance.

## Agent-requested current-thread closure

The selected transport is **native RPC host tools**, not reverse bridge requests. Noli registers `noli_thread_get` and `noli_thread_finish` with `set_host_tools`; OMP emits `host_tool_call`, and Noli answers `host_tool_result`. The plugin registers no duplicate tools and performs no thread lifecycle operation or database write. Protocol 1 of the socket bridge remains Noli-to-plugin only.

`src/thread-control.ts` intercepts the host tools using OMP's trusted `ctx.agent.kind`, never arguments supplied by the model. Only `main` is allowed; subagents are blocked before forwarding. Official OMP's advisor tool pool excludes dynamically registered RPC host tools (verified in the running binary); advisor contexts are also rejected by the guard. This depends on OMP preserving its host-tool wrapping and advisor exclusion: re-run runtime checks when upgrading OMP, and do not grant advisors a copy of a main-session wrapped control tool.

Availability requires **both** a live socket client that completed authenticated `hello` for the current session adoption and both native host tools (`sourceInfo.source === "sdk"`). Environment variables or plugin installation alone do not enable control. Switch, branch and tree adoption revoke authentication, including returning to an old session ID; Noli must reconnect and complete `hello` again. Disconnect revokes availability. Instructions are request-local `before_agent_start` system policy, not persistent conversation entries, so startup/resume/branch/switch cannot duplicate them. The hidden bundled skill is reachable as `skill://noli` but is not advertised to ordinary terminal sessions.

Agent and capability broadcasts also require a matching authenticated session. A revoked or previous-session socket receives no new events; a freshly authenticated connection restores both subscriptions. Already queued replies remain subject to the existing request/session checks.

### Backend contract (requires companion Noli implementation)

Noli must register exactly these schemas, with `additionalProperties: false`:

```json
[
  { "name": "noli_thread_get", "description": "Read current Noli thread identity, lifecycle, permissions and pending closure.", "parameters": { "type": "object", "properties": {}, "additionalProperties": false } },
  { "name": "noli_thread_finish", "description": "Schedule current-thread settle or archive after completed work and final response; does not close synchronously.", "parameters": { "type": "object", "properties": { "action": { "type": "string", "enum": ["settle", "archive"] } }, "required": ["action"], "additionalProperties": false } }
]
```

Derive the target thread and permissions from the authenticated, owning OMP process/session connection. Neither tool accepts `threadId`, caller identity, credentials, delete or global settings. The guard independently rejects extra arguments and invalid actions. `noli_thread_get` returns a text JSON representation and matching `result.details` containing `{ thread: { id, title }, lifecycle: { settled, archived }, permittedActions: ["settle", "archive"], pendingLifecycleRequest: null | { requestId, action, status: "pending" } }`; permissions may be an empty/subset array. Noli owns every value and must apply permission checks again on finish.

For finish, persist the lifecycle request before acknowledging. Return `host_tool_result` with the original RPC `id`, `result.content: [{ type: "text", text: "...scheduled..." }]` and **`result.details: { status: "scheduled", requestId: "<durable request id>", action: "settle" | "archive" }`**. The plugin refuses a missing, mismatched or completed-state acknowledgement as an error. It never synthesizes success. Backend denials/errors must use `isError: true` and an explanatory text result, not successful details. Noli must respond to every accepted call, including unavailable/unauthorized control.

Keep RPC correlation `id` separate from model `toolCallId` and durable lifecycle `requestId`. Scope the pending-call map to the process/connection **and session generation**. On `host_tool_cancel`, use `targetId` to cancel the correlated request; Noli owns persistence and cancellation of any pending lifecycle action. Serialize cancellation, persistence and application. Cancel or invalidate outstanding requests on session change/disconnect; never apply an old request to a newly active thread. A late acknowledgement after cancellation must not become success. OMP already rejects an aborted call and emits `host_tool_cancel`; the plugin also rejects a success result whose authenticated session was lost. A race after persistence can leave an unknown outcome: inspect the pending request before retrying, not an automatic duplicate request.

Finish only schedules: do not synchronously abort or stop the requesting agent. Noli must allow its final response, wait for actual OMP settlement (including admitted submissions, hidden queued input, asynchronous work and outstanding children), drain final history, then stop the agent and apply settle/archive under its existing lifecycle policy. Noli persists/cancels requests and displays pending/completed actions. Settle is Noli's Mark done: still in the inbox, terminals retained. Archive moves out of the inbox and closes terminals; neither deletes the thread.

### Companion Noli launch and resource changes

Inspected the existing Noli checkout: `crates/noli-adapter-omp/src/lib.rs` currently ignores `host_tool_call` and `host_tool_cancel`. Replace that discard path with authenticated current-session routing, registration, correlated results/cancellation, and server-owned durable scheduling. `crates/noli-server/src/runtime.rs`/`commands.rs` own stop/drain and thread actions; keep lifecycle policy there, not here. **Until those changes exist this plugin cannot schedule a real Noli lifecycle action.**

Registered-plugin loading discovers the sibling `skills/noli/SKILL.md` automatically. The adapter's fallback currently supplies only `-e <package>/src/index.ts`, which loads code but does **not** discover sibling skills. Preferred companion change in `crates/noli-adapter-omp/src/lib.rs`: supply `-e <package>` (the root containing `package.json`); OMP resolves `omp.extensions` and discovers package skills. Alternatively retain the explicit file and pass a session-only `--config <overlay.yml>` containing:

```yaml
skills:
  customDirectories:
    - /absolute/path/to/omp-noli/skills
```

Use the **parent** `skills` directory, not `skills/noli`. Custom-directory arrays replace inherited arrays; preserve other required directories in a launch overlay. No global OMP config workaround. A trusted-file-only launch likewise needs the skill overlay; a copied Markdown file or package metadata alone cannot make file-only loading discover it.

Ship **both** `src/thread-control.ts` and `skills/noli/SKILL.md`, preserving paths, in each companion inventory:

- `app/scripts/bridge-resources.ts` (vendored bridge → desktop resources).
- `crates/noli-adapter-omp/src/bridge.rs::install_bridge` (persistent registered-plugin installation/repair).
- `crates/noli-server/src/bridge_updates.rs` (release allowlist, validation and extraction).
- `crates/noli-client/src/install.rs` (SSH resource transfer and per-file digest inventory).

Update the vendored package and release manifests/digests together. Existing recursive Tauri mapping in `app/src-tauri/tauri.conf.json` covers the staged resource tree; no extra global skill install is needed.

### Agent-control verification

Regression coverage checks main/sub/advisor restrictions, unavailable authentication, provenance, argument injection, invalid/mismatched acknowledgements, backend errors, cancellation, session isolation and request-local instruction deduplication. Bridge tests exercise real socket authentication and revocation. Run `bun test` and `bun run typecheck`.

Real macOS OMP **18.4.12** binary checks exercised a wrapped native host-tool call: main forwarded, backend denial propagated, abort emitted a correlated `host_tool_cancel`, and a real SDK-created child with this guard forwarded no lifecycle call. Runtime advisor available-tool enumeration excluded both control tools. No success-returning Noli backend stub was used. The pinned 18.4.5 npm SDK source could not be imported for the initial probe (`createRatchetPrelude` export missing); the installed binary was used instead.

Skill discovery was exercised in isolated temporary HOME/agent directories: registered plugin (`omp plugin link`, then `omp read skill://noli`), existing file-only fallback (no `skill:noli` in RPC command catalog), package-root `-e` fallback (skill present), and file-only fallback plus `skills.customDirectories` overlay (skill present). No global config was modified. Backend persistence, final-history drain, UI pending/completed actions and actual settle/archive remain **unverified end-to-end**, dependent on the companion Noli implementation above.


## Layout

| Module | Role | Knows OMP? |
| --- | --- | --- |
| `src/protocol.ts` | The wire contract: frame, result and error types, and every closed vocabulary (agent kinds and states, capability names and reasons, discovery statuses and reasons, definition sources, error codes). | No |
| `protocol/noli-bridge.schema.json` | The same contract as JSON Schema (draft 2020-12), for clients in other languages. | No |
| `src/bridge.ts` | Socket, authentication, framing, method dispatch and capability gating, written against the `BridgeHost` interface. | No |
| `src/capabilities.ts` | Shape checks for the internal OMP hooks, reported as protocol reason codes. | By shape only |
| `src/omp-host.ts` | Main OMP adapter: registry, tools, ownership checks, events and observer lifecycle. | Yes |
| `src/agent-output.ts` | Bounded visible native live/parked child transcripts and UTF-16 span pagination. | Native session shape |
| `src/agent-telemetry.ts` | Independent live, retained and cold-restored per-agent telemetry. | Native session/entry shape |
| `src/thread-control.ts` | Native host-tool caller guard, scheduling acknowledgement checks and authenticated request-local skill guidance. | Extension API |
| `src/index.ts` | Extension entry point, environment variables and session authentication adoption. | Types only |

Noli should code against the socket schema and the separate native host-tool contract above, not against this plugin's internals. Tests check that the schema's enumerations match `src/protocol.ts` exactly, and every socket frame the bridge sends in the test suite is validated against the schema.

## Capabilities

Every feature maps to a named capability. Each capability has a source:

- **public**: built only on published `pi.pi` exports.
- **internal**: reaches OMP internals through objects the host already owns. These paths work on official releases today, but they are not a supported OMP API and any release can change them.

| Capability | Source | Backed by |
| --- | --- | --- |
| `agents.list` | public | `pi.pi.AgentRegistry` |
| `agents.list.persisted` | internal | The built-in `read` tool's `history://<id>` lookup runs OMP's persisted-roster scan for the current root session. |
| `agents.output` | public | `pi.pi.loadSessionMessagesReadOnly`, `pi.pi.loadEntriesFromFile`; live children expose `session.messages` and `agent.state.streamMessage`. |
| `agents.steer` | public | `AgentSession.steer` + `queuedMessageCount` |
| `agents.followUp` | public | `AgentSession.followUp` + `queuedMessageCount` |
| `agents.turn` | public | `pi.pi.runSubagentFollowUpTurn`, `pi.pi.discoverAgents` |
| `agents.kill.live` | public | `AgentSession.abort` + `pi.pi.finalizeSubagentLifecycle` |
| `agents.kill.parked` | internal | The built-in `task` tool's `session.agentLifecycle()` returns OMP's `AgentLifecycleManager`; the bridge calls `release(id, ref, { tombstone: true })`. |
| `definitions.list` | public | `pi.pi.discoverAgents` |
| `work.get` | public | `AgentSession` settlement state (`isStreaming`, `hasAdmittedSubmission`, `queuedMessageCount`, `hasPendingAsyncWork()`), `agent.peekSteeringQueue()` / `peekFollowUpQueue()` and `getAsyncJobSnapshot()` |
| `work.cancel` | internal | `AgentSession.asyncJobManager.cancel(id, { ownerId })`, scoped to the root session's agent id, followed by the exact owned `getJob(id).promise` completion barrier. Off (`hook_changed`) if owner identity or completion observation is missing; never cancels unscoped. |

A capability is either `{ available: true, api, detail }` or `{ available: false, api, reason, detail }`. Act on `reason`; `detail` is human-readable text for logs and tooltips and may change between releases.

| Reason | Meaning |
| --- | --- |
| `export_missing` | A required `pi.pi` export is missing. |
| `tool_missing` | A required built-in tool isn't registered (for example, OMP started with `--no-tools`). |
| `hook_changed` | A host object no longer has the shape the internal hook expects. |
| `runtime_failure` | The hook passed its shape check but misbehaved when used. |
| `not_ready` | No top-level session yet. |

**Startup checks.** When the top-level session starts, and after every session switch, branch or tree navigation, the plugin checks each capability. Public capabilities need their `pi.pi` exports. Internal capabilities need the host objects to have the expected shape (tool registered, property present, method callable).

**Warnings.** Whenever the set of disabled capabilities changes, the plugin warns three ways:

- A `Noli bridge: N capability(ies) DISABLED …` notice in the OMP UI (an `extension_ui_request` notify of type `warning` under RPC).
- An OMP log warning.
- The same text on stderr.

Each disabled capability is listed with its reason code and detail.

**Runtime checks.** Internal paths are also checked when used. Parked kill re-probes the lifecycle manager and confirms afterwards that the child really ended terminated with no live session. If it didn't, the capability switches off with `runtime_failure` until the next session adoption, a warning is issued, and the request fails with `internal`. Persisted discovery re-probes the `read` tool before each lookup. If the tool is gone, the capability goes off with `tool_missing` and comes back on as soon as the tool returns. Any other discovery outcome is reported in the listing instead of disabling anything; see the discovery report below.

**Degraded mode.** A disabled capability closes off only the features that depend on it. Everything else keeps working:

- Without `agents.list.persisted`, `agents.list` still returns the agents in the current process, with `discovery.status: "not_requested"`. Children from earlier processes don't appear until a running agent references them.
- Without `agents.kill.parked`, live children can still be killed. Killing a parked child returns `capability_unavailable` and never falls back to reviving it.
- Without the `AgentRegistry` export, every agent capability is off. The socket still accepts `hello` and `capabilities.get`, so Noli can show why.

**Noli contract.** Read the capabilities before using a feature. `hello` returns the full capability map, and `capabilities.get` re-checks and returns it. A `capabilities.changed` event is pushed whenever the map changes. Hide or disable UI for any capability with `available: false`. Even so, handle `capability_unavailable` on every call, because internal capabilities can be switched off between the check and the call.

## Protocol 1

UTF-8 newline-delimited JSON over a Unix domain socket. `protocol/noli-bridge.schema.json` is the authoritative definition of every frame the bridge sends; this section summarizes it.

Requests have `id`, `method`, and optional `params`. The first request must be `hello`, with the shared token in `params.token`. A successful `hello` returns `{ protocol: 1, sessionId, pid, capabilities }`. A failed `hello` closes the connection, and so does any malformed frame (invalid JSON, or JSON that isn't an object) sent before a successful `hello`.

Every later request must carry the current `sessionId`. Replies look like:

```json
{ "type": "response", "id": 1, "ok": true, "result": {} }
{ "type": "response", "id": 1, "ok": false, "error": { "code": "unknown_agent", "message": "..." } }
{ "type": "response", "id": 1, "ok": false, "error": { "code": "capability_unavailable", "message": "...", "capability": "agents.kill.parked", "reason": "tool_missing" } }
```

Replies can arrive out of order; match them by `id`. Two kinds of event arrive between replies:

- `{ type: "event", event: "agent.changed", sessionId, agent }`
- `{ type: "event", event: "capabilities.changed", sessionId, capabilities }`

**Closed vocabularies.** Every enumeration is closed. When OMP reports a value the bridge doesn't recognize, the bridge sends `unknown` rather than passing OMP's value through, so a new OMP state can't reach Noli as an unexpected string.

**Agent rows.** `{ id, name, kind, parentId, state, live, streaming, activity, definition, model, effort, requests, contextTokens, contextWindow, inputTokens, outputTokens, sessionCost, tokensPerSecond, createdAt, lastActivity }`. Identical fields are sent in `agents.list` and `agent.changed`.

| Field | Values |
| --- | --- |
| `kind` | `main`, `sub`, `advisor`, `unknown` |
| `state` | `running` (streaming, or a live session with queued input, including hidden next-turn messages), `idle` (live, waiting), `parked` (not in memory, revivable), `terminated` (killed, not revivable), `unknown`. A live main row whose registry status still says running but which is neither streaming nor holding queued input is `idle`. |
| `live` / `streaming` | A live in-memory session is attached / it's producing output now. |
| `definition` | Name of the agent definition the child runs (see `definitions.list`), or `null` when OMP didn't record one. |
| `model` / `effort` | This agent's serving model identity and applied thinking level, falling back to its own session getters; never the effort-suffixed model selector or root metrics. Unavailable values are `null`. |
| `requests` | This agent's assistant request count, separate from task-result usage. |
| `contextTokens` / `contextWindow` | This session's observed current context use/capacity, or `null`. Cold-restored capacity remains `null`; context is recovered only from explicit persisted observations. |
| `inputTokens` / `outputTokens` / `sessionCost` | Native session accounting, including task-result usage and persisted `model_usage` entries where applicable. Invalid/missing values are `null`; observed zero spend is valid. |
| `tokensPerSecond` | This session's `tokenRate.rate()` throughput, or `null` when unobservable or parked. |
| `createdAt`, `lastActivity` | Milliseconds since the Unix epoch. |

Rows don't include file paths or other host storage details.

Live telemetry uses each agent's own `getSessionStats()` and serving model; changes are published during active work. Parking retains observed fields keyed by the actual registry object, not its reusable ID. Cold restoration uses `loadEntriesFromFile`, follows the persisted leaf/parent chain, excludes abandoned branches and uses OMP's native context/accounting projection. Optional telemetry failures never reject listing or root chat. Observers, timers and caches are cleared on release.

**Methods.**

| Method | Parameters | Requires | Behavior |
| --- | --- | --- | --- |
| `capabilities.get` | none | none | Returns `{ capabilities }`. |
| `definitions.list` | none | `definitions.list` | Returns `{ definitions: [{ name, description, source }] }`, with `source` one of `bundled`, `user`, `project`, `unknown`. These are the names `agents.turn` accepts. |
| `agents.list` | optional `persisted` (boolean) | `agents.list`; an explicit `persisted: true` also requires `agents.list.persisted` | Returns `{ agents, discovery }` for the current root session. When `persisted` is omitted, discovery runs if `agents.list.persisted` is available, and it never makes the listing fail. With discovery, OMP first registers children left by earlier processes as `parked`, or `terminated` if they were killed. |
| `agents.output` | `agentId`, optional `offset`, optional `limit` | `agents.output` | Returns visible live/parked output for an already-known owned child, without revival or a model turn. See pagination below. |
| `agents.steer` | `agentId`, `text` | `agents.steer` | Queues an interrupting user message on a live child. Returns `{ queued: true }` once queued, not when the turn completes. |
| `agents.followUp` | `agentId`, `text` | `agents.followUp` | Queues a follow-up user message on a live child. Returns `{ queued: true }` once queued. |
| `agents.turn` | `agentId`, `text`, optional `agent` | `agents.turn` | Runs one turn through OMP's monitored follow-up driver, reviving the child first if it is parked. Uses `params.agent` if given, otherwise the row's `definition`. Returns `{ output, exitCode, aborted }`. Only one bridge turn per child at a time. |
| `work.get` | none | `work.get` | Returns `{ settled, streaming, admittedSubmission, queued, hiddenQueued, pendingAsyncWork, jobs, undeliveredResults }`. `settled` uses OMP's RPC settle predicate, extended to retain cancellation-draining job bodies. `queued` includes hidden next-turn messages; `hiddenQueued` subtracts only user-authored messages still in the actual steering/follow-up queues, never live-steered chips already consumed from those queues. `jobs` includes running and cancellation-draining background jobs `{ id, kind, label, startedAt, agentId }`, with `kind` one of `bash`, `task`, `eval`, `unknown`. |
| `work.cancel` | `jobId` | `work.cancel` | Cancels one background job owned by the root session and waits for that exact job's body and cleanup to finish. Returns `{ cancelled }`; `false` if already finished or not owned. No timeout is reported as successful cancellation; foreign jobs are neither aborted nor awaited. During cancellation drain, `work.get` retains the job and reports `pendingAsyncWork: true`, `settled: false`. |
| `agents.kill` | `agentId` | `agents.kill.live` or `agents.kill.parked`, depending on the child | Live child: abort, then terminal release. Parked child: terminal release with no revival and no turn. OMP writes the tombstone, so the child stays terminated after a restart. Returns `{ killed, mode: "live" \| "parked" }`. |

**Child output pagination.** Params are `{ agentId: string, offset?: number, limit?: number }`; `offset` must be a nonnegative safe integer and `limit` an integer from 1 to 500 (default 100). Omitted `offset` selects the newest page. An offset is an exclusive upper line bound; each returned page is oldest-to-newest. Pass `nextOffset` to read the next older page; `null` means the beginning.

```ts
{
  agentId: string;
  text: string;
  spans: { id: string; role: string; tool: string | null;
    created_ms: number; start: number; end: number }[];
  nextOffset: number | null;
}
```

Span offsets index `text` in **UTF-16 code units**, with exclusive `end`. Native roles, message/block IDs, timestamps and tool names are preserved; when a native ID is absent, a deterministic `derived:` identity is used. Output includes user/assistant text and tool calls/results, including in-flight assistant text/calls; hidden thinking, signatures and provider payloads are excluded. Parked reads use OMP's `loadSessionMessagesReadOnly` export and existing persisted entries, never a session writer, lock, revival or model turn. This is display history, not provider replay.

Pages contain at most **500 lines** and **64 KiB UTF-8** of rendered text (span metadata is subject to the separate bridge frame bound). Lines over **8 KiB UTF-8** are explicitly marked `[… line truncated …]` and clipped on a Unicode code-point boundary. Persisted files over **64 MiB** are rejected before loading and checked again afterwards. Byte-limited pages preserve older cursors.

**Noli integration:** ship this published package, not a locally patched plugin. Consume `agents.output` and the row fields above; add `src/agent-output.ts` and `src/agent-telemetry.ts` to any explicit packaging, release extraction, persistent installation and SSH digest inventories alongside the existing modules and bundled skill. Noli remains responsible for presentation, not transcript/telemetry implementation. Protocol 1 is additive; update strict client decoders and respect capability availability.

**Error codes.** `capability_unavailable` errors also carry `capability` and `reason`; no other error does.

| Code | Meaning |
| --- | --- |
| `unauthorized` | `hello` failed or was missing. |
| `stale_session` | The request's `sessionId` isn't the active session. |
| `unknown_agent` | No child with that ID in the current root session. |
| `unknown_definition` | `agents.turn` named a definition that doesn't exist; see `definitions.list`. |
| `definition_required` | `agents.turn` got no `params.agent` and the row has no recorded `definition`. |
| `forbidden_kind` | The target is a main or advisor row. |
| `parked` | Steer or follow-up was sent to a child that isn't live; use `agents.turn`. |
| `already_terminal` | The child was already killed. |
| `busy` | A bridge turn is already running on this child, or a parked kill raced its revival. |
| `capability_unavailable` | The capability this request needs is switched off. |
| `bad_request` | Invalid or missing parameters. |
| `bad_frame` | The frame isn't a valid JSON object. |
| `frame_too_large` | The frame exceeded the size cap; the connection is closed. |
| `unknown_method` | No such method. |
| `not_ready` | The session context isn't established yet. |
| `internal` | Unexpected failure, including a parked kill whose end state couldn't be confirmed. |

**Discovery report.** `agents.list` returns `discovery: { status, reason, detail, restored, pending }`. `restored` lists children this call registered. `pending` lists child transcripts on disk that are still unregistered. `reason` is a stable code or `null`.

| Status | Reason | Meaning | Retries |
| --- | --- | --- | --- |
| `complete` | `null` | Every child transcript is registered. | n/a |
| `skipped` | `host_declined` | OMP scanned this root but declined some transcripts. That is normal for a header-only stub written just before a spawn claims its ID, a released one-shot child, a vibe-owned child, or a transcript that changed after OMP's once-per-root scan in this process already ran. | When the transcript file changes; a restarted process rescans. |
| `skipped` | `previously_declined` | Same, from an earlier call; nothing changed since. | When the transcript file changes. |
| `inconclusive` | `no_scan_evidence` or `lookup_failed` | The lookup gave no evidence OMP scanned this root, or it threw. | Next call. |
| `unavailable` | `capability_unavailable` | The `read` tool is gone; the capability is now off. | When the capability is back. |
| `none` | `null` or `no_root` | No unregistered child transcripts, or the session has no saved root yet. | n/a |
| `not_requested` | `null` | The caller asked for live rows only, or discovery is off. | n/a |

None of these fail the request. The bridge uses OMP's own per-root scan latch on the registry as positive evidence that a scan ran.

**Scoping.** Only `sub` rows can be controlled or read with `agents.output`; root and advisor transcripts are rejected. Output requires a known child whose registry ancestry belongs to the authenticated root and whose canonical transcript path remains inside the root artifact directory. Unknown/foreign agents and symlink escapes are rejected. After asynchronous transcript/telemetry loading, session adoption, registry object identity, ancestry and transcript path are rechecked. Children of an earlier root are left out of listings/events. After a native session switch, requests carrying the old session ID fail with `stale_session`; reconnect and authenticate again.

**Limits.**

- Unauthenticated frames: 4 KiB. Authenticated frames: 1 MiB. Message text: 256 KiB.
- A slow client is disconnected once more than 8 MiB of output is waiting for it.
- Both sides must handle partial socket writes and reconnects.
- Events are not a durable log; call `agents.list` again after reconnecting.

## Known boundaries

- **Internal capabilities can break.** `agents.list.persisted` and `agents.kill.parked` depend on internal OMP details, not a supported API. They rely on:
  - The `read` tool running the roster scan during a `history://` lookup.
  - The `task` tool keeping `session.agentLifecycle`.
  - Child transcripts being stored as `<id>.jsonl` under the root session's artifact directory (the plugin reads those file names to find children OMP hasn't registered yet).
  - OMP tagging the registry with its per-root scan latch under a symbol described `persistedRosterLatches` (the plugin uses this only as evidence that a scan ran; if it disappears, a lookup that restores nothing reports `inconclusive` instead of `skipped`).

  An OMP release can change any of these. The plugin then detects the change, warns and degrades as described above. A supported upstream extension API would remove this risk.
- **Definitions of live children.** OMP records a child's definition on the registry only when it reloads the child from disk. For children spawned while the plugin is loaded, the bridge takes the name from OMP's `task:subagent:lifecycle` event on the extension event bus. OMP registers the child just before that event, so the first `agent.changed` for a new child has `definition: null`, and a second one follows with the name filled in. The name is tied to that specific registry entry, so it's kept across session switches (a branch or tree navigation doesn't stop running children), and a child that reuses an ID gets a new entry and never inherits the old name. A child spawned before the plugin loaded has `definition: null` until OMP reloads it from disk; pass `params.agent` for it.
- **Same-process rescan.** OMP scans each root's persisted children once per process. A transcript that becomes complete later in the same process (without its spawn registering it live) stays `pending` until the next process resumes that root.
- **Out of scope for this channel.** Steer and follow-up only queue messages; use native RPC events and subagent subscriptions to watch activity and completion. `agents.output` provides bounded child display history, not root transcript replay, extension UI rendering, advisor configuration or MCP OAuth.
- **Platform.** The bridge listens on a Unix domain socket and secures it with Unix file permissions, so it runs on macOS and Linux only. Windows needs a different transport, and it isn't yet known which API works there under Bun: Bun documents `Bun.listen` for TCP and Unix sockets only, and its named-pipe support has been demonstrated through `node:net`. `scripts/probe-transport.ts`, run by the manual `windows-probe` workflow, tests both APIs on Windows runners to settle this before any port.

## Verification

`bun test` covers:

- Schema contract: the schema's enumerations match `src/protocol.ts` exactly, every frame the test client receives is validated against the schema, and the schema rejects extra fields (such as a file path), raw host states and mismatched error shapes. Putting a `sessionFile` field back on agent rows makes the suite fail (checked with a negative control).
- Mapping at the adapter level: OMP statuses and kinds map to protocol values, unrecognized ones become `unknown`, rows carry no file paths, definitions come from the registry or the spawn event, definition sources are closed, and probes report reason codes. Spawn definitions survive a session switch, a child replaced under the same ID gets no inherited name whether or not the event carried a transcript path, a start event with no registered child is ignored, and the spawn event pushes one corrected `agent.changed`. The first two fail against the earlier implementations (checked with negative controls).
- Authentication, stale session IDs, read-only kinds and scoping.
- Steer and follow-up refused on parked children.
- `agents.turn`: uses the recorded definition, honors an explicit `params.agent`, and fails with `definition_required` when neither exists.
- Turn exclusion, and parked kill refused while a turn is reviving that child.
- Kill routing (live vs parked).
- Capability advertisement, gating with `capability` and `reason` on errors, `definitions.list`, and change events.
- Persisted-list defaults and degraded listing.
- Discovery outcomes: a stub-only root keeps discovery on and still lists live rows; a stub later completed by its live spawn, or completed before a process restart, is listed; declined transcripts aren't looked up again until they change; inconclusive or throwing lookups don't disable discovery and are retried; a missing `read` tool disables discovery, warns, and recovers when the tool returns.
- Size caps, event auth and shutdown.

`bun run typecheck` checks against the pinned OMP types.

CI (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile`, `bun run typecheck`, `bun run schema:check`, `bun run extension:check` and `bun test` on Ubuntu and macOS for pushes to `main` and pull requests. Generate evolving agent schema definitions from TypeScript with `bun run schema`; `schema:check` rejects drift. CI does not run the installed-binary smoke below. The separate manual Windows transport probe remains experimental; the bridge is Unix-only.

Historical v0.3.0 real-process verification ran the official OMP 18.4.5 binary with an isolated temporary home and a scripted local OpenAI-compatible endpoint (not a real model provider), validating every received frame against the schema:

1. `hello` reported protocol 1 with every capability on. `definitions.list` returned the bundled and user definitions.
2. Spawned a child and let it park. Its row showed `state: parked` and `definition: task` (from the spawn event). `agents.turn` without `params.agent` used that definition; a made-up name returned `unknown_definition`.
3. Resumed the session in a new process. The default listing restored the child (`discovery: complete`). Killing it parked returned `mode: "parked"`, and its row then showed `state: terminated`.
4. Started with `--no-tools`: both internal capabilities reported off with `reason: tool_missing`, and `persisted: true` returned `capability_unavailable` with `capability` and `reason` set.

37 frames were received across the runs and all passed schema validation. Every run exited 0 with no non-JSON stdout lines.

This shows the harness and protocol lifecycle works. It says nothing about the quality of real-model coding work. No GUI and no real model provider were exercised.

### v0.3.2 child transcript and telemetry verification

Run `bun run smoke:child` with compiled official **OMP 18.5.1** on `PATH`. To verify an installed release, run `bun scripts/smoke-child.ts /path/to/installed/omp-noli`. The runner uses disposable HOME/profile/config/workdir, an environment allowlist and a loopback scripted provider; it needs no external credentials and removes its process, sockets and temporary files.

The exercised flow spawns a native child with `child-smoke/child-model:high`, independently configures the root with low effort and a different context capacity, observes the child's prompt/live text/tool call, releases a real held extension tool, and completes through native `yield`. A short disposable `task.agentIdleTtlMs` parks the child. Bridge output and telemetry are compared with independent registry/session APIs and the native persisted transcript. UTF-16 spans, native roles/IDs/timestamps/tool names, pagination, changing telemetry, positive live throughput and valid zero spend are checked. Five repeated parked reads assert no revival, model requests or child/root transcript hash/stat mutation. Root task-result usage is included without inflating root assistant requests.

The behavior suite also covers bounds, foreign/root/advisor rejection, symlink escape, stale asynchronous ownership, AgentRef reuse, cold active-branch restoration, missing cost and observer cleanup. No Noli GUI, external model provider or production billing was exercised.
