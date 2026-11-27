# omp-noli

An OMP extension that gives Noli a private local control channel. It runs next to native `omp --mode rpc-ui`. The primary session's conversation, history, dialogs, model controls and subscriptions stay on native RPC. This channel lists and controls the subagents (children) of the current root session. It is not the Noli GUI.

## Runtime and loading

Package **omp-noli 0.1.0** requires published, unmodified **OMP 19.0.1 or newer** (peer dependency `>=19.0.1`), plus **Bun 1.4.4 or newer in the OMP runtime**. Development and qualification target OMP 19.0.1. Managed Gateway launches negotiate native provenance against the selected SDK; compatible newer releases are not blocked by a certified-version allowlist. Missing required native APIs fail visibly with update guidance. Install development dependencies with `bun install`. Load the package root with `omp -e /path/to/omp-noli --mode rpc-ui`, or through the package's `omp.extensions` declaration.

Launchers pass `NOLI_BRIDGE_DIR` and `NOLI_BRIDGE_TOKEN_FILE` (a path, never secret bytes) in the child process environment. Use a fresh private directory for each OMP process and a cryptographically random bootstrap token written to a current-user-owned 0600 regular file. At factory time the extension opens without following symlinks, validates ownership and permissions, reads and unlinks the file synchronously. The token file is the only bootstrap input. Without the directory or token file, the extension does not start Bridge or Gateway setup; its host-tool authentication guards still install and deny unauthenticated Noli tool calls. Do not log tokens or put them on the command line. Gateway-backed launches consume the token on the first successful hello and use authenticated `session.adopt` across session changes. Non-Gateway connections authenticate independently with hello.

For managed Gateway sessions, Noli writes secret-free `gateway-providers.json` and the routing overlay before launch. The extension registers that catalog at factory time with `noli-pending`, then requests `gateway.bind {sessionId}` on the authenticated transport. Noli replies with `{token, expires_ms}`; provider re-registration replaces the in-memory key even for an existing model object. `gateway.ready` acknowledges installation before the first prompt. Same-session renewal retains the valid key until its replacement is installed synchronously; failed or timed-out binds retry with bounded exponential backoff. Actual expiry, session change, disconnect and shutdown clear the key. No Gateway inference credential is written to configuration or credential storage. The native Codex subscription provider uses the scoped `noli-codex-responses` adapter over the stock Responses serializer.

`gateway.ready` reflects the installed credential, not the latest renewal attempt: an unexpired key remains ready during pending/failed renewal, with a safe optional `renewalError` diagnostic while retries fail. An expired key returns `not_ready` even before its expiry timer runs; successful replacement clears the diagnostic. Long-lived credentials use absolute renewal/expiry deadlines split across the runtime timer limit. Sessions without a Gateway catalog advertise `gateway.bind` as unavailable. The exported `ServerFrame` type includes reverse `gateway.bind` requests.

`test/gateway.test.ts` exercises the pinned real SDK registry, availability and auth storage before bind, after two keys and after revoke, and checks all temporary profile files for credential bytes. `test/review-gateway.test.ts` covers uninterrupted renewal, real streaming auth retries, native lifecycle rebinding and process-launched bootstrap isolation. Bridge fixtures cover one-use hello, bind acknowledgement, stale-session rejection and rebind/revoke. The Noli repository owns the mock-upstream managed-process security smoke and actual Gateway 429 classifier fixture.

## Gateway request correlation (bridge protocol 1)

Bridge protocol 1 carries the out-of-band shapes in `src/protocol.ts`. Managed Anthropic uses the scoped `noli-anthropic-messages` custom API adapter. The native `noli-codex` provider uses `noli-codex-responses` over the stock Responses serializer; other Gateway providers remain plain catalog registrations. All paths use public SDK extension/stream APIs and are installed for the root and every child that rejoins the launch's Gateway (`src/claude-hooks.ts`).

Before Gateway binding, hello advertises `gateway.native.provenance` with API `native-provenance-v1`. The root awaits selected-SDK preparation and probes the exact side-channel marker and live compaction runner budget; missing support is unavailable with explicit update guidance. The capability requires private authenticated Messages dispatch, non-OAuth helper serialization, both Responses APIs and exact dispatch-bound OMP compaction. Compatible releases are admitted by capability, not a certified-version allowlist; updates remain explicit.

Reverse requests on the authenticated bridge, each answered by Noli with a response frame:

- `producer.session {ompSessionId, parentOmpSessionId, agentKind, agentId, epochEntryId, ompVersion, systemPrefix}` on `session_start`/`switch`/`branch`/`tree`. Children name their spawning agent's session (`ctx.agent.parentId`), or the root. Announcements are kept and re-sent root-first, parent before child, after every `hello` and `session.adopt`.
- `producer.branch {ompSessionId, leafId, resetEntryIds}` on session events, and before a registration whenever the branch's `/clear` boundaries changed.
- `gateway.request.register {ompSessionId, facts}` → `{requestReference}` from an async `context` handler for registered Anthropic Messages and OpenAI Responses/Codex Responses models. The provider name and API must both match the launch catalog. A main/subagent reference remains stable across dispatch retries; side turns are classified by their actual stock `:side:` routing session, never by reusing main facts. The exact side marker comes from the launched SDK selected by `NOLI_OMP_SDK_ROOT` (with a matching package version), or the pinned SDK digest; an unknown marker fails closed.
- `producer.compaction {ompSessionId, phase, facts, dispatchSessionId?}`: `begin` carries RequestFacts v1 with `compactionKind` over the summarized messages and the exact generated side dispatch session, and waits for acknowledgement. Every supported Gateway family runs OMP's standard exported `compact` with OMP's preparation, prompts, summary result and `completeSimple` transport. Only authenticated producer context is added; provider-native remote compaction is disabled. The bracket attempts an acknowledged `end` (`facts: null`, dispatch omitted) in `finally`, including errors and cancellation. A cleanup-only transport failure logs a warning but cannot discard an already completed trusted summary or conceal the original compaction failure. An abandoned bracket cannot classify any other side dispatch as compaction, and expires at the bounded handler budget.

OMP is the only compaction runtime, for both manual and automatic compaction. The extension does not reproduce Claude Code prompts, round selection, threshold policy or summary formatting, and never rewrites OMP system instructions, tools or history. Stock OMP races handlers against a short budget, so compaction first lifts the launched SDK's actual runner budget (verified by `ExtensionRunner` identity); missing capability fails visibly instead of allowing a timed-out wrapper to trigger an unregistered second summary. A private `x-noli-producer-session-id` header identifies each compaction dispatch as the authenticated bracket owner plus an internal `:side:` nonce. Managed OpenAI Responses models use stock `compat.sessionHeader`; managed Anthropic's scoped adapter sets the same private header from the actual dispatch's `options.sessionId`. Noli authenticates that identity against the bound launch and strips private control data before native transport. A provider-looking session header cannot substitute for it.

Compaction dispatch IDs use the owning UUID, `:side:`, and a 128-bit base64url nonce: exactly 64 characters. This preserves exact stock Responses cache-key/header equality; a longer ID would be hashed by OMP's cache-key normalizer. Arbitrary caller-supplied cache keys remain unsupported by the native boundary.

Managed Anthropic's scoped adapter delegates to stock `streamSimple` with the real Anthropic compatibility policy and `isOAuth: false`: the local Gateway bearer is not a provider OAuth credential. This prevents generated device-identity metadata for standalone task labels, summaries and other helpers without deleting caller metadata. It preserves request hooks using the registered model identity and lets the outer SDK dispatcher own concurrency and dispatch callbacks exactly once. Only the existing authenticated session-only metadata exception is permitted at native ingress; arbitrary metadata still fails visibly. No SDK source/prototype or official client is patched, and unrelated providers keep their normal serializers.

The custom API retains `Model.compatConfig` discovery overrides when resolving the real Anthropic wire policy, then preserves any effective model overrides. Main-loop facts and retained helpers see that same policy. Unsupported sampling controls stay omitted; metered models that advertise sampling retain the caller's values.

Local non-OAuth authentication uses a one-hour cache default when the resolved route supports it; other routes stay short. Explicit `cacheRetention` wins over the stock `PI_CACHE_RETENTION` override, which wins over that route default. The adapter never rewrites serialized cache markers. Real-SDK HTTP regressions cover long/short/disabled retention and precedence.

For `openai-responses`, the stock serializer emits actual dispatch identity through `compat.sessionHeader` as `x-noli-producer-session-id`. The stock `openai-codex-responses` serializer instead emits its actual dispatch session in `x-codex-turn-metadata.session_id`; Noli consumes that existing metadata without synthesizing provider identity or rewriting headers. Its separate `session_id` header is parent/cache affinity and is never authoritative. If a private header and Codex turn metadata are both present, their actual sessions must agree. Both APIs retain the same authenticated producer/reference admission and root-versus-side rules.

A synchronous `before_provider_request` handler adds a top-level `noli_request: {session, ref, warm}` member to every supported Gateway-bound Anthropic Messages or OpenAI Responses body; Noli strips it before native dispatch. `ref` is the pending main-loop registration, retained across retries and side contexts (null when registration failed). Side turns retain that ownership proof without registering fabricated main facts; their actual dispatch session selects auxiliary admission and permits validation of inherited session-only metadata. The server authenticates each reference's producer ownership with a session-scoped stateless proof, so long-lived detached helpers do not depend on retained main admission records. Main admission still requires bounded live state and presentation budget; expired, reclaimed or settled main references never reopen main work. Active responses retain admission until completion/drop starts the idle retry window. Actual side-routing headers select auxiliary context unless they exactly match the dispatch registered in the authenticated compaction bracket. `warm` is set for 30 s after a `cache_warming_decision` of `warm` and forces `ref: null`. Because the handler never awaits, the runner's timeout and fail-open paths cannot drop its value. Ownership is never inferred from a prompt-cache key, user text or a root-session fallback.

Producer facts (`src/claude-facts.ts`, the RequestFacts v1 wire schema) are recomputed from OMP's actual session branch and context event. Summary source text is OMP's own rendered summary context. Epoch and branch identities preserve ownership across resets and restarts. These are private Noli control facts, never upstream provider identity emulation.

Optional `facts.prevToolDurations` describes actually executed tools for Noli's private control channel. Each session keeps its own timings; root sessions observe `tool_result`, while children observe `tool_execution_end` without adding handlers that would change OMP speculative execution. Timings reset for new prompts and overflow retries. No provider identity headers are synthesized.

`src/system-prefix.generated.ts` (`bun run system-prefix`) is generated from the matching official SDK, currently 19.0.1. Managed launches read the exact side-turn marker from their selected SDK source when its package version matches the running SDK; compatible newer releases are not blocked merely by version. Missing semantic marker or handler-budget capability fails closed.

OMP drops raw compatibility overrides for optional fields absent from its default resolved record, including `sessionHeader`. For generic Responses, the managed lifecycle enriches actual resolved models before dispatch; each owned registry has one instance-local adapter around its public `resolver`, preserving receiver and arguments. This reaches advisors and fallback models retained across catalog refreshes without credential substitution. Anthropic instead uses the scoped adapter described above. Both retain each helper's actual dispatch session without substituting root/main facts. Regressions exercise retained models across credential changes, the actual standalone task-label helper, explicit metadata and concurrent dispatch with a single provider slot.

Stock OMP's manual `/handoff` and `/btw` use real `:side:` dispatch sessions even when no producer `context` event is emitted; the stock routing header supplies their auxiliary lineage without fabricated main facts. Any `context` handler makes the stock runner clone request messages and defeats the identity-keyed conversion memo for that call; the produced bytes are unchanged. `assistant_message` cannot change non-text blocks.

## Codex encrypted-history binding

The scoped Codex adapter preserves original reasoning IDs alongside their encrypted payloads. OMP's generic REST replay sanitizer omits those IDs; Codex history import invents replacements, and OpenAI rejects the next request with `invalid_encrypted_content`. The adapter matches exact ciphertext to authoritative response items or retained thinking signatures in that call's own context. It never guesses an ID, rewrites saved history, resurrects removed reasoning or uses another request's context. Missing or ambiguous original IDs fail before dispatch. Metered and unrelated providers keep their existing serialization.

Request hooks observe the restored body under the registered model identity. Discovery compatibility and actual helper session headers are preserved; the outer dispatcher owns concurrency and callbacks once. Regression coverage uses the real SDK serializer and HTTP boundary for main and serialized/resumed helper contexts, checks ciphertext/ID binding, unchanged source history and single-slot dispatch, and rejects unrecoverable history without sending it.

**Local accounting limitation:** OMP 19.0.1 compares the registered API identity when estimating native Responses reasoning. The scoped `noli-codex-responses` adapter therefore gives different local context/reasoning estimates for retained `openai-responses` turns, which can change automatic compaction timing. Provider-reported usage and saved history are unchanged. This preserves replay bindings without modifying the official OMP runtime; it does not claim stock local-accounting equivalence.

## Native run lifecycle

- `work.get`, `tree.navigate` and `goal.budget` use OMP's public `isRunActive` and `wakeSources` APIs. An open run remains unsettled across pauses and scheduled continuations; native wake sources include owned job deliveries, resumable child runs and queued peer/result messages, not merely currently running job rows.
- Tree/goal mutations are blocked during active or paused runs, native wake sources, busy/admission/transition/disposal/queue guards and owned cancellation cleanup. Cancelling one root-owned job awaits that exact job's body/cleanup completion; it never waits for unrelated jobs or cancels another owner.
- Roster state retains active paused runs through the shared session handle's native run identity. Telemetry samples both `agent_pause` and final `agent_end` without treating a per-loop pause as settlement. RPC/extension loop-end flags do not distinguish those states.
- Summary conversion uses OMP's application-aware converter, preserving attached-file content and user shell/Python results in both ordinary history and split-turn prefixes while honoring context exclusions.

## Paged root history

- `history.entries` (`main-only-v1`) returns one bounded page of the root session's append history, the same `SessionManager.getEntries()` objects OMP's `get_entries` RPC returns. OMP answers `get_entries` with the whole history (or its whole tail after `since`) and caps a logical RPC frame at 64 MiB.
- Pages hold whole entries up to `maxBytes` UTF-8 bytes (4096..786432, default 524288), so a response fits the bridge's 1 MiB frame. An entry larger than a page arrives as contiguous `partial` slices of its JSON text (UTF-16 offsets, never splitting a surrogate pair) for the client to reassemble. An unknown `since` fails with `unknown_since`, as `get_entries` does.
- Each request reads the canonical list: no cache, second index or mutation.

## Native watch and model roles

- `host.forge_watch` (`main-only-v1`) negotiates Noli's owning-main `noli_forge_watch`. Children and advisors cannot call or relay this tool.
- `until: "pipeline-success"` accepts native review, Git-ref and exact pipeline/run targets. Exactly one of `number`, `git_ref` or `run` is required; exact targets use a validated native pipeline handle and remain pinned by Noli. Noli owns terminal-status semantics; required-check `green` and review `ready` retain their distinct meanings.
- Watch selectors are bounded before forwarding: watch IDs are at most 256 UTF-8 bytes, review numbers are positive decimal strings of at most 40 digits, and git refs are at most 1024 UTF-8 bytes without control characters. Invalid combinations, malformed handles and caller overrides fail before forwarding.
- `host.model_roles` (`session-v1`) negotiates the read-only `noli_model_roles` roster. Main agents, attributed children through the authenticated relay, and advisors may read it. It takes no arguments; Noli resolves routes and validates the caller lifecycle.
- Noli's bundled read-only reviewers (`noli-reviewer`, `noli-council-1..3`) are never offered `noli_forge_write_v1` or `noli_forge_write_status_v1`, and a reviewer identity cannot run them. OMP offers every extension tool to a child whatever its definition's `tools:` list says and exposes only the definition name (`ctx.agent.name`), so the relay registers proposal tools from the first lifecycle context that names a different definition. Noli refuses reviewer writes independently.
- Native Noli owns registration metadata, schemas and authority. Forge read resource and handle-kind selectors come from Noli's generated read/write schemas. Shape errors identify unsupported resources or unexpected fields; native Rust validates each request and authorizes the caller.
- The native schema snapshots live in `protocol/noli-forge-{read,write}-tool.schema.json`. Refresh them and their runtime selector module with `NOLI_FORGE_PROTOCOL_DIR=/path/to/noli/protocol bun run schema`; `bun run schema:check` checks snapshots offline, and the same environment variable with `schema:check` checks against Noli source. Generated selector checks accept Windows CRLF; schema refresh validates all inputs and outputs before staging replacements.

## Windows transport

- The bridge speaks protocol 1 over a named pipe following Noli's `noli_platform::ipc` contract. Windows owner and DACL checks correspond to Unix mode checks.
- At `<dir>\omp-<pid>.sock` the bridge creates a new private key file (it refuses if one exists), holding 32 random lowercase hex digits. It creates `\\.\pipe\noli-<sha256(path)>-<key>`, hashing the path's UTF-8 bytes exactly as Noli spelled them. The pipe is owned by the user's SID and its protected DACL grants only that SID. `FILE_FLAG_FIRST_PIPE_INSTANCE` rejects a squatted name; `PIPE_REJECT_REMOTE_CLIENTS` rejects remote clients. The key is written only after the pipe exists and deleted on shutdown only if it still holds this bridge's key.
- Each client must run as the bridge's user, checked through `GetNamedPipeClientProcessId` and the client's token. Other users receive `unauthorized` and are disconnected. Noli opens the pipe with identification-only SQOS and requires the pipe's owner to be its own SID before sending anything.
- Bootstrap file and directory pass Noli's `fs::is_private` and `is_owned_by_current_user` rules. The owner must be the user, or Administrators for an elevated process. No NULL DACL or unattributable allow ACE is allowed; every applicable allow ACE must name the user, SYSTEM or Administrators. The bootstrap file is a regular file with one name and 1 to 4096 bytes, not a link. Checks, reads and deletion use the same no-follow handle. A missing directory receives Noli's inheritable owner-only DACL.
- `src/windows-native.ts` calls kernel32, advapi32 and ntdll through `bun:ffi`. Overlapped reads, writes and listens use `NtReadFile`, `NtWriteFile` and `NtFsControlFile`, returning NTSTATUS directly without depending on `GetLastError` surviving the JS engine. One unreferenced worker (`src/windows-waiter.ts`) blocks in `WaitForMultipleObjects` and posts completions. Nothing polls or keeps OMP alive.

## Forge tools and context

- `host.forge_resource`, `host.forge_read` and `host.forge_write` advertise `api: "session-v1"`. `noli_forge_status` takes no arguments and reports the thread's repository/host, acting account, sign-in state, permitted operations, approval mode and known rate-limit headroom.
- Subagents get reads, status and write proposals through relay tools calling the root session's genuine RPC host tools under fresh unguessable call IDs. Runtime identity is recorded out of band; the root guard adds `noli_requester` itself and rejects model-supplied attribution. Relays stay pinned to their original root session, never a replacement. Noli validates the native child lifecycle, derives repository/account authority from the root and names the child in approval. Advisors are read-only. Root release, adoption or authentication loss ends child calls and discards stale results.
- Before each child turn, the relay checks for newly registered host tools from the same pinned root. Task reminders wait for post-registration prompt preparation; discarded preparation does not consume them.
- `forge-context.json` supplies the root/child prompt binding block. Noli rewrites it only when repository, account or sign-in state changes, preserving identical prefixes. Lost bindings, parents or authentication remove stale guidance. `forge-task.json` supplies one hidden `noli-forge-task` message per change after the conversation, never in the prefix; removal sends one clearing reminder. Shutdown from a replaced session does not release the current parent's binding.
- Guidance prefers Noli forge tools and Tasks, with `noli_forge_status` when unsure. Use `gh`/`glab` or independent credentials only for unconfigured hosts, missing accounts, unsupported operations or an explicit user request, with a one-sentence reason. Explicit CLI instructions win. A Noli denial is a decision, not an outage: never repeat a denied operation elsewhere unless the user asks. Noli tools never accept credentials/raw endpoints or borrow CLI credentials.
- Forge writes wait for approval (automatic in Yolo, otherwise human) and dispatch. Denial, expiry and dispatch failure are errors; do not end a turn asking for approval. Local tag/tag-push proposals return immediately because they need an idle thread. `{status:"pending_approval", operation_id}` is not proof of outcome; read operation status for canonical results and never automatically replay an unknown outcome. Merge proposals capture native protection/CI evidence and replace the supplied precondition (`{"kind":"ci"}` suffices); unmet requirements are error blockers.
- Write envelopes accept number and branch forms with optional `target`/`precondition`, including milestone `number`/`title`. Byte limits include runtime-added requester attribution and the actual relay call ID. Proposals exceeding the native SDK's 64 MiB logical-frame limit fail before dispatch; chunked requests above 1 MiB remain supported.
- Persisted task snapshots, retained watch targets and metadata for files explicitly handed to Noli use bounded native cursors that expire on authority changes. Completions are fenced by invocation even if SDK call IDs or input objects are reused.
- CI log/report grants bind the exact job, revision, attempt and content class. In Yolo (`write_approval: "automatic"`), Noli grants exact reads without asking; otherwise a human permits the read in the message dock after `forge_content_consent_required`. Human denial stands in every mode, leaving Yolo ends automatic grants, and each grant is limited to 256 KiB, 16 pages and five minutes.

### Forge resource contract

An authenticated `capabilities.get({hostTools:true})` must return `host.forge_resource` with `available: true, api: "session-v1"` before Noli registers `noli_forge_resource`. Optional host-tool markers are omitted from hello, default capability reads and broadcasts. They describe explicit bootstrap negotiation before `set_host_tools`, not backend availability or already-registered tools. Read and write tools negotiate their own capabilities independently.

The model and UI share `ForgeResourcesRequest`: `{action:"resolve_review", number:"42"}` or `{action:"read", handle, offline:false}`. Handles contain exactly `origin`, `account`, `repository`, `kind`, `resource` and `web_url`. Repository identity is `github` with decimal-string `repository_id` and opaque `node_id`, or `gitlab` with decimal-string `project_id`. Resource identity uses native Rust `type` variants. Provider IDs/numbers stay decimal strings, including values beyond JavaScript's safe integer range; optional IDs/numbers may be absent or null.

The guard checks trusted caller role, authenticated ownership, SDK provenance, request shape and unknown fields. Noli checks selected repository/account, canonical deployment and provider/kind agreement. URLs never prove authority. The plugin makes no provider requests or raw-URL proxy and discovers no CLI credentials. Bounded `untrusted_provider_content` and authorized backend errors are preserved only while session/tool/authentication epoch match. The oldest current authentication owns that epoch; secondary connections do not change it. Revocation, replacement, adoption, shutdown and reauthentication cannot restore stale results; cancellation consumes admission.

## Child transcript snapshots and revisions

Every `agents.output` result **requires** `revision`, an opaque whole-transcript identity (`sha256:` plus 64 hex digits), for live and parked children. Compare it for equality only. Each message digest hashes the visible segments' JSON identity `[id, role, tool, created_ms, length]` followed by exactly `length` raw UTF-16LE code units of unclipped text. The transcript hashes message digests in order. This encoding preserves lone surrogates without normalization; any visible text, identity or boundary change affects the revision, but hidden thinking/signatures/provider payloads do not.

The optional request `revision` selects a retained transcript for consistent pagination while the child streams. Reads without it retain a snapshot only after post-read ownership checks succeed. At most two snapshots per child are retained, ordered by read start so a slower older read cannot displace a newer one. One LRU cache is bounded to 1024 children and 32 Mi units of text/identity UTF-16 cost plus fixed segment/message/snapshot overhead. Other children are evicted before this child's older snapshot; its newest remains if it fits alone. Empty transcripts are not retained and release drops the child's snapshots. Parked per-message digests share this cache.

Snapshots are scoped to bridge instance, session adoption, root artifact directory/session, child ID, canonical transcript path and live session object. Every frozen read repeats ownership checks; mismatch drops snapshots and returns `snapshot_expired`. Adoption/release drops all snapshots. Foreign children remain `unknown_agent`. Missing/evicted revisions return `snapshot_expired`; malformed revisions return `bad_request`.

Digest reuse requires every rendered field and full text to compare equal, never file metadata. Live caches key on message objects; parked caches use message position. Hashing uses 64 Ki-unit slices without copying a whole message or adding file reads.

`agents.output` returns `agent_absent` when a child previously exposed by this root leaves the registry. Foreign/unlisted IDs or unreadable/escaping transcripts return `unknown_agent`. The 1024 most recent departed IDs are remembered per root; older ones fall back to `unknown_agent`. Other agent methods keep `unknown_agent`.

## Opening threads

`noli_thread_open` requires owning-main authentication, native SDK provenance and explicit bootstrap negotiation of `host.thread_open.api: "main-only-v1"`. Children/advisors, foreign sessions, invalid arguments and stale acknowledgements are rejected. Explicit current-user directives open directly; otherwise Noli retains a proposal for confirmation above the message dock. Noli validates the source turn and owns authorization, durable exactly-once creation and approval. Referenced screenshots remain native image-content blocks with bounded history metadata.

## Supplemental native session controls

The authenticated socket admits only the current root session: both the connection's hello binding and each request's `sessionId` must match. Session adoption invalidates authentication. The adapter rechecks root identity after asynchronous operations; a stale mutation response must never be replayed automatically.

Supported method capabilities are `tree.navigate`, `goal.budget`, `memory.status`, `memory.search`, and `memory.save`. Parameters are defined together in `src/protocol.ts` and the generated JSON schema. Native results are returned without a success wrapper: navigation cancellation stays top-level `cancelled`, disabled memory reports inactive, and supported saves that store nothing preserve `stored: 0`. Hindsight recall is normalized to the native structured search contract `{backend, query, count, items}`.

Navigation omits only the SDK-only `sessionContext` rendering cache (a duplicate transcript); native editor text/images and cancellation remain intact. Noli must consume editor recall without submitting it. Any result exceeding the 1 MiB frame limit returns `frame_too_large` with an explicit unknown-outcome/no-replay warning, not fake success. Transcript/goal mutations refuse streaming, compaction, retries, bash/eval, session transitions, admitted submissions, queued messages, disposal and pending asynchronous work. A disappearing/replaced goal or unconfirmed budget cannot receive a successful acknowledgement.


- `tree.navigate`: `{targetId, summarize?}` calls public `AgentSession.navigateTree`, not branch creation. Active transcript work is refused. It preserves session identity and follows native user-message editor recall/leaf behavior.
- `goal.budget`: `{tokenBudget}` accepts a positive safe integer or `null` to remove a budget. It calls `AgentSession.goalRuntime.onBudgetMutated`, which updates the actual goal, accounting, budget-limited state and persisted mode history. It requires an existing goal and idle snapshot admission; it never changes the global wallet setting.
- `memory.status`: `{}` calls `ExtensionContext.memory.status` and reports actual callable backend capabilities. Initialized Hindsight exposes search through the owned public session state's client; no state means inactive/unsearchable. Other backends must report active plus searchable/writable and expose the corresponding SDK operation. Clients fetch status automatically and omit unavailable operations silently; method presence alone is not backend support. Capability snapshots are scoped to the root session, cwd, settings revision and Hindsight state.
- `memory.search`: `{query, limit?}` uses `AgentSession.getHindsightSessionState().client.recall` for initialized Hindsight. This is OMP's already-configured/authenticated client: endpoint, bearer token, timeouts, bank, project recall tags/match, recall budget, max tokens and types come from the native session, with no Noli setup form or independent client. The exact SDK has no recall item-limit parameter, so the validated 1–1000 limit truncates returned items after recall; count equals the returned item count. Recall text/id/type/mentioned_at/finite score map to content/id/source/timestamp/score. Native failures and malformed responses are errors, not empty successes; upstream error bodies are not echoed. Supported other backends route through `ExtensionContext.memory.search`. Session, cwd, configuration or Hindsight scope changes invalidate asynchronous results.
  Hindsight `config.scoping` is captured at operation entry. In-place changes during either native status lookup or recall invalidate the response with `stale_session`, even if the native state/config object and settings revision are unchanged; a status-time change is rejected before recall starts, and previous-scope recall results are never returned.
- `memory.save`: `{content, context?, source?, importance?}` calls `ExtensionContext.memory.save` only for an active writable backend; importance must be finite. Native backend redaction/storage semantics remain authoritative. Local memory supports save but not structured search; Hindsight exposes recall but not structured save. Off and unsupported operations return `capability_unavailable`, not successful zero-item/zero-stored placeholders.

**Not full native control completion:** `memory.clear`, `memory.enqueue`, `memory.stats`, `memory.diagnose` and `memory.queue` are not advertised. The public `MemoryRuntimeContext` exposes only status/search/save; `MemoryBackend.clear/enqueue/stats/diagnose/queuePreview` and the backend resolver are not root SDK exports. `plan.propose` is also unavailable: the public extension/session surface has no installed host review/proposal controller. Proposal is not approval. Plan approval, live MCP/LSP/DAP controllers and secure secret-input similarly require upstream public authenticated controllers/input transport. Known unsupported requests return `capability_unavailable`, never slash prompts, arbitrary built-in tool execution or fake success. No internal module import or vendored OMP fallback fills those gaps.

The native smoke covers official SDK navigation identity/leaf, native budget persistence/removal, off/local capability refusal, local save with an independent persisted learned.md assertion, and an authenticated ephemeral loopback Hindsight endpoint. It constructs a real official session from isolated OMP settings and checks the native request's bearer authentication, exact bank/project tags, recall tuning, returned item limit and error propagation. It needs no model provider, production Hindsight service or new user configuration; it temporarily removes inherited `HINDSIGHT_*` overrides, restores them on exit, never prints the generated token and removes its temporary files. Smoke assertions are not a claim that production backend availability was exercised.

The smoke's Hindsight session intentionally does not use `restrictToolNames`: official OMP disables memory lifecycle startup under that policy. It enables autolearn only in isolated settings to use OMP's awaited startup path; no prompt or agent-stop event occurs, so no model capture runs.


The directory is created with mode 0700. It is rejected if it is a symlink, isn't owned by the current user, or is accessible to group/other. The socket is `<dir>/omp-<pid>.sock`, mode 0600. The bridge never removes an existing endpoint at that path. On shutdown it closes clients, removes the socket and unsubscribes its listeners. Windows applies the same rules through owners and DACLs and serves a named pipe published by a key file at that path (see Windows transport).

Only the top-level session starts the server; child sessions never open listeners. All runtime objects come from OMP itself: the host-injected `pi.pi` exports, the shared extension event bus, and the host's own built-in tool instances for the internal paths described below. Importing a second copy of OMP's runtime would control a different agent registry, so package dependencies are used for types only.

## Agent images

The authenticated owning main agent can call `noli_show_image({ source: "screenshots/result.png", caption: "Updated screen" })` to show a local image inline in Noli. `source` may also be an HTTP(S) image URL. Relative paths resolve in the agent's current working directory on its machine, including remote workspaces. Children and advisors return image paths or URLs to their parent rather than publishing directly.

Supported formats are PNG, JPEG, WebP and GIF, up to 5 MiB per image. The plugin bounds local/streaming download bytes, checks complete image containers and native pixel decoding through Bun.Image, honors cancellation, and rechecks authenticated session ownership before submission.

The tool submits a displayed `noli.image` custom message with optional text and an image block `{ type: "image", data: "<base64>", mimeType: "image/png" }`. Busy sessions use noninterrupting `aside` delivery; idle submission does not start a model turn. Its acknowledgement is **submitted**, not proof of persistence or that the user has viewed it. Image bytes are not duplicated in the tool result. OMP may normalize large images before delivery and uses blob-backed native persistence.

Noli translates displayed `noli.image` custom entries to assistant image/text blocks, retains image data through persistence/projection, and renders image blocks inline with previews. Packaging, persistent installation and SSH transfer must include `src/images.ts`.

## Agent downloadable files

The Noli server registers `noli_attach_file({ path: "report.pdf", caption: "Optional explanation" })` on the native host-tool surface. This plugin guards the call using trusted main-agent identity, SDK tool provenance and current-session socket authentication. An authenticated explicit `capabilities.get({hostTools:true})` returns `host.attach_file` with `available: true, api: "main-only-v1"` as bootstrap permission to register that tool, not proof that it is already registered. Hello, default capability reads and broadcasts omit this optional policy marker. Attachment guidance is injected only while the authenticated SDK tool is actually registered; lifecycle guidance is independent.

Noli retains any local regular file up to 100 MiB (including empty files) in server-owned storage and persists an attachment card before acknowledging `{ status: "attached", attachmentId: "..." }`. Relative paths resolve against the server-side thread workspace. The client downloads exact bytes through authenticated chunked transport and Save As; HTML is saved, not run inside Noli. The plugin rejects missing durable acknowledgements and child/advisor calls. Markdown links alone do not attach files.

## Agent-requested current-thread closure

Thread lifecycle controls use **native RPC host tools**, not reverse bridge requests. Noli registers `noli_thread_get` and `noli_thread_finish` with `set_host_tools`; OMP emits `host_tool_call`, and Noli answers `host_tool_result`. The plugin registers no duplicate tools and performs no thread lifecycle operation or database write.

`src/thread-control.ts` intercepts the host tools using OMP's trusted `ctx.agent.kind`, never arguments supplied by the model. Only `main` is allowed; subagents are blocked before forwarding. Official OMP's advisor tool pool excludes dynamically registered RPC host tools (verified in the running binary); advisor contexts are also rejected by the guard. This depends on OMP preserving its host-tool wrapping and advisor exclusion: re-run runtime checks when upgrading OMP, and do not grant advisors a copy of a main-session wrapped control tool.

Availability requires **both** a live socket client authenticated for the current session adoption and both native host tools (`sourceInfo.source === "sdk"`). Environment variables or plugin installation alone do not enable control. Switch, branch and tree adoption revoke old-session authentication, including returning to an old session ID; Gateway-backed launches use authenticated `session.adopt`, while non-Gateway connections authenticate independently with hello for the current session. Disconnect revokes availability. Instructions are request-local `before_agent_start` system policy, not persistent conversation entries, so startup/resume/branch/switch cannot duplicate them. The hidden bundled skill is reachable as `skill://noli` but is not advertised to ordinary terminal sessions.

Referenced-thread access is a separate **read-only** host tool: `noli_thread_read({ reference_id, before?, limit? })`, negotiated only when `host.thread_read` advertises `api: "main-only-v1"`. `reference_id` is a public opaque identifier for a user-selected reference, not a target thread ID or bearer grant; `thread_id` is rejected. The authenticated main-agent and SDK-provenance checks apply. Noli returns 1–50 items with image-aware 30 MiB bounds and 5 MiB per-image validation; remote payloads use permission-checked chunks inside Mesh's existing limit. The plugin preserves native image-content results unchanged. Noli alone resolves local/connected remote references, issues scoped grants and activates them after durable user submission. Captured context, unsent references and copied identifiers never confer access. The extension never dials remote servers or issues/transports grants. Denial, cancellation, revocation and unavailable sources remain errors, not empty success.

`host.thread_read` is bootstrap permission to register the SDK host tool, not evidence that registration has already happened. The sequence is authenticated `hello` → `capabilities.get({hostTools:true})` → Noli's `set_host_tools` registration → guarded tool calls. Requiring an existing SDK registration in the capability probe would deadlock this negotiation. Calls still require current-session authentication and actual SDK provenance independently; a capability advertisement alone never authorizes a read.

Agent and capability broadcasts also require a matching authenticated session. A revoked or previous-session socket receives no new events; a freshly authenticated connection restores both subscriptions. Already queued replies remain subject to the existing request/session checks.

### Backend contract
Noli registers the lifecycle schemas below; attachment support additionally registers `noli_attach_file` after explicitly negotiating the host-tool policy. All schemas use `additionalProperties: false`:

```json
[
  { "name": "noli_thread_get", "description": "Read current Noli thread identity, lifecycle, permissions and pending closure.", "parameters": { "type": "object", "properties": {}, "additionalProperties": false } },
  { "name": "noli_thread_finish", "description": "Schedule current-thread settle or archive after completed work and final response; does not close synchronously.", "parameters": { "type": "object", "properties": { "action": { "type": "string", "enum": ["settle", "archive"] } }, "required": ["action"], "additionalProperties": false } },
  { "name": "noli_attach_file", "description": "Persist a local regular file as a downloadable current-thread attachment.", "parameters": { "type": "object", "properties": { "path": { "type": "string" }, "caption": { "type": "string" } }, "required": ["path"], "additionalProperties": false } }
]
```

Derive the target thread and permissions from the authenticated, owning OMP process/session connection. None of these tools accepts `threadId`, caller identity, credentials, delete or global settings. The guard independently rejects extra arguments and invalid actions. `noli_thread_get` returns a text JSON representation and matching `result.details` containing `{ thread: { id, title }, lifecycle: { settled, archived }, permittedActions: ["settle", "archive"], pendingLifecycleRequest: null | { requestId, action, status: "pending" } }`; permissions may be an empty/subset array. Noli owns every value and must apply permission checks again on finish.

For finish, persist the lifecycle request before acknowledging. Return `host_tool_result` with the original RPC `id`, `result.content: [{ type: "text", text: "...scheduled..." }]` and **`result.details: { status: "scheduled", requestId: "<durable request id>", action: "settle" | "archive" }`**. The plugin refuses a missing, mismatched or completed-state acknowledgement as an error. It never synthesizes success. Backend denials/errors must use `isError: true` and an explanatory text result, not successful details. Noli must respond to every accepted call, including unavailable/unauthorized control.

Keep RPC correlation `id` separate from model `toolCallId` and durable lifecycle `requestId`. Scope the pending-call map to the process/connection **and session generation**. On `host_tool_cancel`, use `targetId` to cancel the correlated request; Noli owns persistence and cancellation of any pending lifecycle action. Serialize cancellation, persistence and application. Cancel or invalidate outstanding requests on session change/disconnect; never apply an old request to a newly active thread. A late acknowledgement after cancellation must not become success. OMP already rejects an aborted call and emits `host_tool_cancel`; the plugin also rejects a success result whose authenticated session was lost. A race after persistence can leave an unknown outcome: inspect the pending request before retrying, not an automatic duplicate request.
For attachments, persist owned bytes and timeline metadata before acknowledging `result.details: {status:"attached", attachmentId:"..."}`. Lost authentication after commit is an **unknown outcome**, not a retry instruction: inspect the owning conversation before any retry. Never accept old-session results into a newly adopted session or bypass the authenticated guard to avoid duplicate uploads.

Finish only schedules: do not synchronously abort or stop the requesting agent. Noli must allow its final response, wait for actual OMP settlement (including admitted submissions, hidden queued input, asynchronous work and outstanding children), drain final history, then stop the agent and apply settle/archive under its existing lifecycle policy. Noli persists/cancels requests and displays pending/completed actions. Settle is Noli's Mark done: still in the inbox, terminals retained. Archive moves out of the inbox and closes terminals; neither deletes the thread.

### Noli launch and resource integration

Noli owns authenticated current-session routing, registration, correlated results/cancellation and durable scheduling. Stop/drain and thread lifecycle policy belong in the server, not this extension.

Registered-plugin loading discovers the sibling `skills/noli/SKILL.md` automatically. Package-root `-e <package>` loading resolves `omp.extensions` and discovers package skills. File-only `-e <package>/src/index.ts` loading needs a session-only `--config <overlay.yml>` containing:

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

Regression coverage checks main/sub/advisor restrictions, unavailable authentication, provenance, argument injection, invalid/mismatched acknowledgements, backend errors, cancellation, session isolation and request-local instruction deduplication. Bridge tests exercise real socket authentication and revocation. Skill discovery is covered for registered plugins, package-root loading and file-only loading with the explicit skill overlay.


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
| `agents.followUp` | public | Local `AgentSession.followUp`; cross-thread `AgentSessionHandle.prompt(..., { streamingBehavior: "followUp" })`. |
| `agents.turn` | public | `pi.pi.runSubagentFollowUpTurn`, `pi.pi.discoverAgents` |
| `agents.kill.live` | internal | The built-in `task` tool's lifecycle `release(id, ref, { tombstone: true })` plus `AgentSessionHandle.abort`, started together with terminal release first, as in native RPC cancellation. |
| `agents.kill.parked` | internal | The built-in `task` tool's `session.agentLifecycle()` returns OMP's `AgentLifecycleManager`; the bridge calls `release(id, ref, { tombstone: true })`. |
| `definitions.list` | public | `pi.pi.discoverAgents` |
| `work.get` | public | `AgentSession` settlement state (`isRunActive`, `isStreaming`, `hasAdmittedSubmission`, `queuedMessageCount`, `wakeSources`), `agent.peekSteeringQueue()` / `peekFollowUpQueue()` and `getAsyncJobSnapshot()`; owned cancellation body/cleanup remains pending until its completion barrier drains |
| `work.cancel` | internal | `AgentSession.asyncJobManager.cancel(id, { ownerId })`, scoped to the root session's agent id, followed by the exact owned `getJob(id).promise` completion barrier. Off (`hook_changed`) if owner identity or completion observation is missing; never cancels unscoped. |
| `history.entries` | main-only-v1 | The root session's `sessionManager.getEntries()` / `getLeafId()`, the list behind OMP's `get_entries` RPC. Off (`not_ready`) before a root session is adopted. |

A capability is either `{ available: true, api, detail }` or `{ available: false, api, reason, detail }`. Act on `reason`; `detail` is human-readable text for logs and tooltips and may change between releases.

| Reason | Meaning |
| --- | --- |
| `export_missing` | A required `pi.pi` export is missing. |
| `tool_missing` | A required built-in tool isn't registered (for example, OMP started with `--no-tools`). |
| `hook_changed` | A host object no longer has the shape the internal hook expects. |
| `runtime_failure` | The hook passed its shape check but misbehaved when used. |
| `not_ready` | No top-level session yet. |

**Startup checks.** When the top-level session starts, and after every session switch, branch or tree navigation, the plugin checks each capability. Public capabilities need their `pi.pi` exports. Internal capabilities need the host objects to have the expected shape (tool registered, property present, method callable).
**Warnings.** Whenever the set of disabled non-memory capabilities changes, the plugin warns three ways. Unavailable memory capabilities remain negotiated for honest operation gating, but never appear in these notices: unsupported memory controls are silently omitted from the UI.

- A `Noli bridge: N capability(ies) DISABLED …` notice in the OMP UI (an `extension_ui_request` notify of type `warning` under RPC).
- An OMP log warning.
- The same text on stderr.

Each disabled non-memory capability is listed with its reason code and detail.

**Runtime checks.** Internal paths are also checked when used. Parked kill re-probes the lifecycle manager and confirms afterwards that the child really ended terminated with no live session. If it didn't, the capability switches off with `runtime_failure` until the next session adoption, a warning is issued, and the request fails with `internal`. Persisted discovery re-probes the `read` tool before each lookup. If the tool is gone, the capability goes off with `tool_missing` and comes back on as soon as the tool returns. Any other discovery outcome is reported in the listing instead of disabling anything; see the discovery report below.

**Degraded mode.** A disabled capability closes off only the features that depend on it. Everything else keeps working:

- Without `agents.list.persisted`, `agents.list` still returns the agents in the current process, with `discovery.status: "not_requested"`. Children from earlier processes don't appear until a running agent references them.
- Without `agents.kill.parked`, live children can still be killed. Killing a parked child returns `capability_unavailable` and never falls back to reviving it.
- Without the `AgentRegistry` export, every agent capability is off. The socket still accepts `hello` and `capabilities.get`, so Noli can show why.

**Noli contract.** Read the capabilities before using a feature. `hello` returns the full capability map, and `capabilities.get` re-checks and returns it. A `capabilities.changed` event is pushed whenever the map changes. Hide or disable UI for any capability with `available: false`. Even so, handle `capability_unavailable` on every call, because internal capabilities can be switched off between the check and the call.

## Protocol 1

UTF-8 newline-delimited JSON over a Unix domain socket, or on Windows over the named pipe described under Windows transport. `protocol/noli-bridge.schema.json` is the authoritative definition of every frame the bridge sends; this section summarizes it.

Requests have `id`, `method`, and optional `params`. The first request must be `hello`, with the token from `NOLI_BRIDGE_TOKEN_FILE` in `params.token`. A successful `hello` returns `{ protocol: 1, sessionId, pid, capabilities }`. Clients must reject any other protocol version. A failed `hello` closes the connection, and so does any malformed frame (invalid JSON, or JSON that isn't an object) sent before a successful `hello`. Gateway-backed launches consume the token on the first successful hello and use authenticated `session.adopt` across session changes. Non-Gateway connections authenticate independently with hello, including after session changes.

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
| `agents.output` | `agentId`, optional `offset`, `limit`, `revision` | `agents.output` | Returns visible live/parked output with a required transcript `revision` for an already-known owned child, without revival or a model turn. See pagination below. |
| `agents.steer` | `agentId`, `text` | `agents.steer` | Queues an interrupting user message on a live child. Returns `{ queued: true }` once queued, not when the turn completes. |
| `agents.followUp` | `agentId`, `text` | `agents.followUp` | Queues a follow-up user message on a live child. Returns `{ queued: true }` once queued. |
| `agents.turn` | `agentId`, `text`, optional `agent` | `agents.turn` | Runs one turn through OMP's monitored follow-up driver, reviving the child first if it is parked. Uses `params.agent` if given, otherwise the row's `definition`. Returns `{ output, exitCode, aborted }`. Only one bridge turn per child at a time. |
| `work.get` | none | `work.get` | Returns `{ settled, streaming, admittedSubmission, queued, hiddenQueued, pendingAsyncWork, jobs, undeliveredResults }`. `settled` uses OMP's RPC settle predicate, extended to retain cancellation-draining job bodies. `queued` includes hidden next-turn messages; `hiddenQueued` subtracts only user-authored messages still in the actual steering/follow-up queues, never live-steered chips already consumed from those queues. `jobs` includes running and cancellation-draining background jobs `{ id, kind, label, startedAt, agentId }`, with `kind` one of `bash`, `task`, `eval`, `unknown`. |
| `history.entries` | optional `since`, `offset`, `maxBytes` | `history.entries` | Returns `{ sessionId, leafId, entries, partial?, more }`: whole root-session entries strictly after `since` in append order, greedily up to `maxBytes` UTF-8 bytes (4096..786432, default 524288). If the first remaining entry alone exceeds the budget, `entries` is empty and `partial` `{ id, offset, total, text }` carries a slice of its `JSON.stringify` text; pass `offset` (UTF-16 units) with the same `since` to continue it. `more` reports anything left. Unknown `since` fails `unknown_since`; an `offset` past the entry or inside a surrogate pair fails `bad_request`. |
| `work.cancel` | `jobId` | `work.cancel` | Cancels one background job owned by the root session and waits for that exact job's body and cleanup to finish. Returns `{ cancelled }`; `false` if already finished or not owned. No timeout is reported as successful cancellation; foreign jobs are neither aborted nor awaited. During cancellation drain, `work.get` retains the job and reports `pendingAsyncWork: true`, `settled: false`. |
| `agents.kill` | `agentId` | `agents.kill.live` or `agents.kill.parked`, depending on the child | Live child: abort, then terminal release. Parked child: terminal release with no revival and no turn. OMP writes the tombstone, so the child stays terminated after a restart. Returns `{ killed, mode: "live" \| "parked" }`. |

**Child output pagination.** Params are `{ agentId: string, offset?: number, limit?: number, revision?: string }`; `offset` must be a nonnegative safe integer, `limit` an integer from 1 to 500 (default 100) and `revision` a nonempty string of at most 256 characters. Omitted `offset` selects the newest page. An offset is an exclusive upper line bound; each returned page is oldest-to-newest. Pass `nextOffset` to read the next older page; `null` means the beginning. Every result requires `revision`; pages read at different times belong to the same transcript only if those values are equal. Passing the newest page's `revision` serves older pages from that retained transcript, or fails with `snapshot_expired`.

```ts
{
  agentId: string;
  text: string;
  spans: { id: string; role: string; tool: string | null;
    created_ms: number; start: number; end: number }[];
  nextOffset: number | null;
  revision: string; // required whole-transcript identity
}
```

Span offsets index `text` in **UTF-16 code units**, with exclusive `end`. Native roles, message/block IDs, timestamps and tool names are preserved; when a native ID is absent, a deterministic `derived:` identity is used. Output includes user/assistant text and tool calls/results, including in-flight assistant text/calls; hidden thinking, signatures and provider payloads are excluded. Parked reads use OMP's `loadSessionMessagesReadOnly` export and existing persisted entries, never a session writer, lock, revival or model turn. This is display history, not provider replay.

Pages contain at most **500 lines** and **64 KiB UTF-8** of rendered text (span metadata is subject to the separate bridge frame bound). Lines over **8 KiB UTF-8** are explicitly marked `[… line truncated …]` and clipped on a Unicode code-point boundary. Persisted files over **64 MiB** are rejected before loading and checked again afterwards. Byte-limited pages preserve older cursors.

**Noli integration:** ship this published package, not a locally patched plugin. Consume `agents.output` and the row fields above; add `src/agent-output.ts` and `src/agent-telemetry.ts` to explicit packaging, release extraction, persistent installation and SSH digest inventories alongside the other modules and bundled skill. Noli remains responsible for presentation, not transcript/telemetry implementation. Use the protocol 1 schema and respect capability availability.

**Error codes.** `capability_unavailable` errors also carry `capability` and `reason`; no other error does.

| Code | Meaning |
| --- | --- |
| `unauthorized` | `hello` failed or was missing. |
| `stale_session` | The request's `sessionId` isn't the active session. |
| `unknown_agent` | No child with that ID in the current root session. `agents.output` also uses it for a registered agent outside this root, a child without an owned transcript and a transcript that escapes the root artifact directory. |
| `agent_absent` | `agents.output` only: OMP's registry no longer has an agent this root previously listed, typically a finished one-shot child that OMP released. Unlisted IDs get `unknown_agent`. The bridge remembers the 1024 most recent releases per root (`DEPARTED_LIMIT`); older releases, and any release before a root change, fall back to `unknown_agent`. Saved observations of the child remain valid; reading again cannot succeed until a roster change registers the ID again. |
| `snapshot_expired` | `agents.output` with `revision` only: the transcript with that revision is no longer retained. Read the newest page again. |
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
| `unknown_since` | `history.entries` got a `since` entry id that is not in the root session's history. |

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

**Scoping.** Only `sub` rows can be controlled or read with `agents.output`; root and advisor transcripts are rejected. Output requires a known child whose registry ancestry belongs to the authenticated root and whose canonical transcript path remains inside the root artifact directory. Unknown/foreign agents and symlink escapes are rejected. After asynchronous transcript/telemetry loading, session adoption, registry object identity, ancestry and transcript path are rechecked. Children of an earlier root are left out of listings/events. After a native session switch, requests carrying the old session ID fail with `stale_session`; bind the current session with authenticated `session.adopt` for Gateway-backed launches or a new hello for non-Gateway connections.

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
- **Windows test coverage.** On Windows, CI runs the transport and privacy suites (`windows-security`, `windows-pipe`, `bridge` and `review-gateway`), not all of `bun test`. Two other suites fail on Windows only while removing their temporary directory, because the pinned OMP SDK keeps session files open after `dispose()`. The forge-read smoke fixture compares a POSIX link spelling. The bridge-peer refusal path (a client running as another user) has no automated test, since the pipe's DACL already keeps such a client from opening it.

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

CI (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile`, `bun run typecheck`, `bun run schema:check`, `bun run extension:check` and `bun test` on Ubuntu and macOS for pushes to `main` and pull requests. A Windows job runs the same checks with the transport and privacy suites listed under "Known boundaries". Generate evolving agent schema definitions from TypeScript with `bun run schema`; `schema:check` rejects drift. CI does not run the installed-binary smoke below.

### Child transcript and telemetry verification

Run `bun run smoke:child` with compiled official **OMP 19.0.1** on `PATH`. To verify an installed release, run `bun scripts/smoke-child.ts /path/to/installed/omp-noli`. The runner uses disposable HOME/profile/config/workdir, an environment allowlist and a loopback scripted provider; it needs no external credentials and removes its process, sockets and temporary files. Its required native `yield` uses an explicit output schema with `task.structured: true`, rather than relying on the former schema-free yield behavior.

The exercised flow spawns a native child with `child-smoke/child-model:high`, independently configures the root with low effort and a different context capacity, observes the child's prompt/live text/tool call, releases a real held extension tool, and completes through native `yield`. A short disposable `task.agentIdleTtlMs` parks the child. Bridge output and telemetry are compared with independent registry/session APIs and the native persisted transcript. UTF-16 spans, native roles/IDs/timestamps/tool names, pagination, changing telemetry, positive live throughput and valid zero spend are checked. Five repeated parked reads assert no revival, model requests or child/root transcript hash/stat mutation. Root task-result usage is included without inflating root assistant requests.

The behavior suite also covers bounds, foreign/root/advisor rejection, symlink escape, stale asynchronous ownership, AgentRef reuse, cold active-branch restoration, missing cost and observer cleanup. No Noli GUI, external model provider or production billing was exercised.
