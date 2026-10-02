# omp-noli

An OMP extension that gives Noli a private local control channel. It runs next to native `omp --mode rpc-ui`. The primary session's conversation, history, dialogs, model controls and subscriptions stay on native RPC. This channel lists and controls the subagents (children) of the current root session. It is not the Noli GUI.

## Runtime and loading

Works with official OMP releases; no custom build is needed. Developed and verified against OMP 18.4.5, with Bun. Install development dependencies with `bun install`. Load `src/index.ts` with `omp -e /path/to/omp-noli/src/index.ts --mode rpc-ui`, or through the package's `omp.extensions` declaration.

The launcher passes `NOLI_BRIDGE_DIR` and `NOLI_BRIDGE_TOKEN` in the child process environment. If either is missing, the extension does nothing. Use a fresh private directory for each OMP process and a cryptographically random token. Don't log the token or put it on the command line. The extension never writes the token to disk or sends it over RPC.

The directory is created with mode 0700. It is rejected if it is a symlink, isn't owned by the current user, or is accessible to group/other. The socket is `<dir>/omp-<pid>.sock`, mode 0600. The bridge never removes an existing endpoint at that path. On shutdown it closes clients, removes the socket and unsubscribes its listeners.

Only the top-level session starts the server; child sessions never open listeners. All runtime objects come from OMP itself: the host-injected `pi.pi` exports, the shared extension event bus, and the host's own built-in tool instances for the internal paths described below. Importing a second copy of OMP's runtime would control a different agent registry, so package dependencies are used for types only.

## Layout

| Module | Role | Knows OMP? |
| --- | --- | --- |
| `src/protocol.ts` | The wire contract: frame, result and error types, and every closed vocabulary (agent kinds and states, capability names and reasons, discovery statuses and reasons, definition sources, error codes). | No |
| `protocol/noli-bridge.schema.json` | The same contract as JSON Schema (draft 2020-12), for clients in other languages. | No |
| `src/bridge.ts` | Socket, authentication, framing, method dispatch and capability gating, written against the `BridgeHost` interface. | No |
| `src/capabilities.ts` | Shape checks for the internal OMP hooks, reported as protocol reason codes. | By shape only |
| `src/omp-host.ts` | The only OMP adapter. Maps OMP's registry, tools, events and transcript layout onto protocol values. | Yes |
| `src/index.ts` | Extension entry point and environment variables. | Types only |

Noli should code against the schema, not against this plugin's internals. Tests check that the schema's enumerations match `src/protocol.ts` exactly, and every frame the bridge sends in the test suite is validated against the schema.

## Capabilities

Every feature maps to a named capability. Each capability has a source:

- **public**: built only on published `pi.pi` exports.
- **internal**: reaches OMP internals through objects the host already owns. These paths work on official releases today, but they are not a supported OMP API and any release can change them.

| Capability | Source | Backed by |
| --- | --- | --- |
| `agents.list` | public | `pi.pi.AgentRegistry` |
| `agents.list.persisted` | internal | The built-in `read` tool's `history://<id>` lookup runs OMP's persisted-roster scan for the current root session. |
| `agents.steer` | public | `AgentSession.steer` + `queuedMessageCount` |
| `agents.followUp` | public | `AgentSession.followUp` + `queuedMessageCount` |
| `agents.turn` | public | `pi.pi.runSubagentFollowUpTurn`, `pi.pi.discoverAgents` |
| `agents.kill.live` | public | `AgentSession.abort` + `pi.pi.finalizeSubagentLifecycle` |
| `agents.kill.parked` | internal | The built-in `task` tool's `session.agentLifecycle()` returns OMP's `AgentLifecycleManager`; the bridge calls `release(id, ref, { tombstone: true })`. |
| `definitions.list` | public | `pi.pi.discoverAgents` |
| `work.get` | public | `AgentSession` settlement state (`isStreaming`, `hasAdmittedSubmission`, `queuedMessageCount`, `hasPendingAsyncWork()`, `getQueuedMessages()`) and `getAsyncJobSnapshot()` |
| `work.cancel` | internal | `AgentSession.asyncJobManager.cancel(id, { ownerId })`, scoped to the root session's agent id. Off (`hook_changed`) when the session reports no agent id: OMP's manager only enforces ownership when given an owner filter, so the bridge never cancels unscoped. |

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

**Agent rows.** `{ id, name, kind, parentId, state, live, streaming, activity, definition, createdAt, lastActivity }`.

| Field | Values |
| --- | --- |
| `kind` | `main`, `sub`, `advisor`, `unknown` |
| `state` | `running` (streaming, or a live session with queued input, including hidden next-turn messages), `idle` (live, waiting), `parked` (not in memory, revivable), `terminated` (killed, not revivable), `unknown`. A live main row whose registry status still says running but which is neither streaming nor holding queued input is `idle`. |
| `live` / `streaming` | A live in-memory session is attached / it's producing output now. |
| `definition` | Name of the agent definition the child runs (see `definitions.list`), or `null` when OMP didn't record one. |
| `createdAt`, `lastActivity` | Milliseconds since the Unix epoch. |

Rows don't include file paths or other host storage details.

**Methods.**

| Method | Parameters | Requires | Behavior |
| --- | --- | --- | --- |
| `capabilities.get` | none | none | Returns `{ capabilities }`. |
| `definitions.list` | none | `definitions.list` | Returns `{ definitions: [{ name, description, source }] }`, with `source` one of `bundled`, `user`, `project`, `unknown`. These are the names `agents.turn` accepts. |
| `agents.list` | optional `persisted` (boolean) | `agents.list`; an explicit `persisted: true` also requires `agents.list.persisted` | Returns `{ agents, discovery }` for the current root session. When `persisted` is omitted, discovery runs if `agents.list.persisted` is available, and it never makes the listing fail. With discovery, OMP first registers children left by earlier processes as `parked`, or `terminated` if they were killed. |
| `agents.steer` | `agentId`, `text` | `agents.steer` | Queues an interrupting user message on a live child. Returns `{ queued: true }` once queued, not when the turn completes. |
| `agents.followUp` | `agentId`, `text` | `agents.followUp` | Queues a follow-up user message on a live child. Returns `{ queued: true }` once queued. |
| `agents.turn` | `agentId`, `text`, optional `agent` | `agents.turn` | Runs one turn through OMP's monitored follow-up driver, reviving the child first if it is parked. Uses `params.agent` if given, otherwise the row's `definition`. Returns `{ output, exitCode, aborted }`. Only one bridge turn per child at a time. |
| `work.get` | none | `work.get` | Returns the root session's observed settlement state: `{ settled, streaming, admittedSubmission, queued, hiddenQueued, pendingAsyncWork, jobs, undeliveredResults }`. `settled` is OMP's own RPC settle predicate over the other fields. `queued` includes hidden next-turn messages; `hiddenQueued` is the part the visible steering/follow-up queues omit. `jobs` are running background jobs `{ id, kind, label, startedAt, agentId }`, with `kind` one of `bash`, `task`, `eval`, `unknown`. |
| `work.cancel` | `jobId` | `work.cancel` | Cancels one running background job owned by the root session. Returns `{ cancelled }`; `false` when it already finished or belongs to another owner. |
| `agents.kill` | `agentId` | `agents.kill.live` or `agents.kill.parked`, depending on the child | Live child: abort, then terminal release. Parked child: terminal release with no revival and no turn. OMP writes the tombstone, so the child stays terminated after a restart. Returns `{ killed, mode: "live" \| "parked" }`. |

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

**Scoping.** Only `sub` rows can be controlled; main and advisor rows are read-only. A child belongs to the current root session only if its transcript is inside that session's artifact directory. Children of an earlier root are left out of listings and events, and can't be controlled. Agent definition lookup is asynchronous, so ownership is checked again afterwards. After a native session switch, requests carrying the old session ID fail with `stale_session`; reconnect and authenticate again to get the new one.

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
- **Out of scope for this channel.** Steer and follow-up only queue messages; use native RPC events and subagent subscriptions to watch activity and completion. The channel doesn't provide transcript replay, extension UI rendering, advisor configuration or MCP OAuth.
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

CI (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile`, `bun run typecheck` and `bun test` on Ubuntu and macOS for pushes to `main` and for pull requests. It doesn't run the real-process smoke below, which needs the `omp` binary. A separate, manually triggered workflow (`.github/workflows/windows-probe.yml`) runs the transport probe, typecheck and tests on Windows x64 and Arm64 runners; its typecheck and test steps don't fail the job, since the suite is expected to fail on Windows until the transport is ported.

The real-process smoke ran the official OMP 18.4.5 binary with an isolated temporary home and a scripted local OpenAI-compatible endpoint (not a real model provider), validating every received frame against the schema:

1. `hello` reported protocol 1 with every capability on. `definitions.list` returned the bundled and user definitions.
2. Spawned a child and let it park. Its row showed `state: parked` and `definition: task` (from the spawn event). `agents.turn` without `params.agent` used that definition; a made-up name returned `unknown_definition`.
3. Resumed the session in a new process. The default listing restored the child (`discovery: complete`). Killing it parked returned `mode: "parked"`, and its row then showed `state: terminated`.
4. Started with `--no-tools`: both internal capabilities reported off with `reason: tool_missing`, and `persisted: true` returned `capability_unavailable` with `capability` and `reason` set.

37 frames were received across the runs and all passed schema validation. Every run exited 0 with no non-JSON stdout lines.

This shows the harness and protocol lifecycle works. It says nothing about the quality of real-model coding work. No GUI and no real model provider were exercised.
