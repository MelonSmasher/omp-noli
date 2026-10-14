# Gates: Noli current-thread agent control

OWNS: src/**, test/**, scripts/**, skills/noli/**, package.json, README.md, GATES.md

Scope: One authenticated host-tool surface, main-agent enforcement, deferred lifecycle contract, bundled skill and launch handoff.

- [x] G1: Host-tool interception enforces runtime caller identity and preserves native acknowledgement/cancellation
  EVIDENCE: OMP 18.4.12 binary main host call propagated backend denial; abort emitted host_tool_cancel with targetId matching request; real SDK child with installThreadControl forwarded no call; advisor runtime pool excluded both host tools. No backend success stub.
- [x] G2: Regression coverage passes for unauthorized callers, unavailable control, errors, cancellation and session isolation
  CHECK: bun test
  EXPECT: 0 fail
  EVIDENCE: automatic-evidence=v1; definition-sha256=2848289c850be8d3ce045ecde828b7a7489811ef4d56388f0fcab104ffd3372d; exit=0; EXPECT=matched; output-sha256=1bcc3134c4e8b5aa1dba5c1bfa107aaf20b5355035aeaf6535feb8a2e64c8bff; output-bytes=1335; shell=/bin/sh; cwd=.; path=3cb731d540f3/24 entries
- [x] G3: Implementation typechecks against pinned runtime
  CHECK: bun run typecheck
  EXPECT: tsc --noEmit
  EVIDENCE: automatic-evidence=v1; definition-sha256=744b708429cc7f90fe4486f7af84fcc673925fc163a55f8037492288cec8af87; exit=0; EXPECT=matched; output-sha256=8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92; output-bytes=15; shell=/bin/sh; cwd=.; path=3cb731d540f3/24 entries
- [x] G4: Registered-package and explicit fallback skill discovery are exercised
  EVIDENCE: Isolated HOME plugin link plus omp read skill://noli succeeded; RPC catalog lacked skill:noli for file-only -e, contained it for package-root -e and file-only plus customDirectories overlay.
- [x] G5: Skill and README specify deferred closure and exact companion Noli changes without implementing backend lifecycle
  EVIDENCE: README contract documents native registration, authenticated session derivation, durable scheduling acknowledgement, cancellation/generation ownership, final-history drain and four packaging inventories. Skill matches inspected existing Noli settle/archive semantics. End-to-end requires companion backend implementation; explicitly unverified.

## Agent image publishing 0.3.1

- [x] IM1: Authenticated main agents submit bounded local/HTTP(S) images without duplicating image bytes in tool results.
  EVIDENCE: Full Bun suite passes with new image coverage for four formats, invalid/truncated/corrupt/oversized inputs, HTTP failures, cancellation, authentication loss and session replacement. Frozen install and strict SDK typecheck pass.
- [x] IM2: Native OMP image history survives process restart.
  EVIDENCE: Compiled OMP 18.5.0 real registered tool/native sendMessage published and flushed displayed noli.image with caption and screenshot. A separate resumed process hydrated identical image bytes through get_entries. No model request; streaming aside drain not exercised. README documents required companion Noli rendering and packaging support.

## Supplemental native controls 0.4.0

- [x] NC1: Official OMP 18.6.1 session APIs implement the five reachable negotiated supplemental methods; unavailable controllers fail closed.
  EVIDENCE: Official public AgentSession.navigateTree/goalRuntime.onBudgetMutated and ExtensionContext.memory status/search/save; README records unsupported upstream controller prerequisites, no slash substitutions.
- [x] NC2: Authentication, session changes, parameter boundaries and native results have regression coverage.
  EVIDENCE: bun test: 207 pass, 0 fail; new native transport and parameter boundary regressions.
  CHECK: bun test
  EXPECT: 0 fail
- [x] NC3: TypeScript and generated protocol-v1 schema agree and extension imports on official runtime.
  CHECK: bun run typecheck && bun run schema:check && bun run extension:check
  EXPECT: EXTENSION LOAD PASSED
  EVIDENCE: bun run typecheck, schema:check and extension:check passed against pinned official 18.6.1.
- [x] NC4: Real official SDK smoke exercises native tree, goal budget and memory behavior without model prompts or system-profile mutation.
  EVIDENCE: bun run smoke:native passed; native leaf recall and identity preserved, goal budget persisted/removed, off memory returns stored 0, local memory stored 1 and independent learned.md content assertion passed.
- [ ] NC5: Review and Ubuntu/macOS CI pass on the aligned release commit before stable publication; isolated published-release installation succeeds.


## Automatic native memory backend search (unreleased)

- [x] NM1: Hindsight recalls through OMP's owned authenticated native client using configured bank, project tags and recall tuning; native failures cannot become empty success.
  CHECK: bun run smoke:native
  EXPECT: OFFICIAL NATIVE SMOKE PASSED
  EVIDENCE: Parent bun run smoke:native passed on official OMP 18.6.1; authenticated ephemeral loopback recall verified configured bank, project tags and recall tuning, upstream failure rejected; local save persisted independently. No production credentials or model prompts.
- [x] NM2: Disabled/unsupported operations fail honestly without memory warning notices, supported backends delegate, limits and stale scope/lifecycle changes have regression coverage.
  CHECK: bun test
  EXPECT: 0 fail
  EVIDENCE: Parent bun test passed: 224 pass, 0 fail, 841 assertions; host warning negative checks retain non-memory warning positive control.
- [x] NM3: Pinned SDK types, protocol-v1 schema and official extension loading remain compatible.
  CHECK: bun run typecheck && bun run schema:check && bun run extension:check
  EXPECT: EXTENSION LOAD PASSED
  EVIDENCE: Parent typecheck, schema:check (SCHEMA CURRENT), extension:check (EXTENSION LOAD PASSED) passed.

## PR 11 installation review fixes

- [ ] RV1: Bootstrap reference-read negotiation precedes SDK host-tool registration; calls remain denied until authenticated SDK registration.
  CHECK: bun scripts/smoke-install.ts --local
  EXPECT: NOLI_RELEASE_INSTALL_OK
- [ ] RV2: Published v0.4.0 installation verifies its native-control contract without requiring the v0.5.0 reference-read contract.
  CHECK: bun scripts/smoke-install.ts v0.4.0
  EXPECT: NOLI_RELEASE_INSTALL_OK
- [ ] RV3: Regression coverage and pinned SDK type compatibility remain intact.
  CHECK: bun test && bun run typecheck
  EXPECT: tsc --noEmit
- [ ] RV4: Installation invokes the checkout's pinned official CLI, not a PATH-selected global OMP; skill formatting has no consecutive blank lines.
  EVIDENCE: Source edits resolve the pinned SDK manifest/bin and invoke its CLI with the resolved Bun command (not process.execPath, which may identify compiled OMP); the reported duplicate skill blank line was removed. Awaiting parent smoke verification; delegated worker ran no checks.

- [ ] RV5: In-place Hindsight scoping changes reject in-flight previous-scope results even when session identity, revision and config object are unchanged.
  CHECK: bun test test/native-controls.test.ts && bun run typecheck
  EXPECT: tsc --noEmit
  EVIDENCE: Awaiting parent review and verification of Sourcery discussion_r4202897066 correction.

- [ ] RV6: Hindsight scoping is captured at operation entry and checked across the asynchronous native status step before recall can start.
  CHECK: bun test test/native-controls.test.ts && bun run typecheck
  EXPECT: tsc --noEmit
  EVIDENCE: Awaiting parent review and verification of Greptile discussion_r4202968419 correction.


## Gateway binding 0.7.0

- [x] GW74-BIND: One-use bootstrap authenticates one transport; gateway bind acknowledgement installs the key before prompt admission; adoption refreshes it and close revokes it.
  CHECK: bun test
  EXPECT: 0 fail
  EVIDENCE: Pinned SDK 18.8.2 suite passed 240 tests and 1006 assertions, including bind/rebind/revoke and bootstrap replay rejection.
- [x] GW74-KEY: Re-registering a provider updates credentials for an existing SDK model object without writing either key to profile files or auth storage; the picker contains only gateway providers.
  CHECK: bun test test/gateway.test.ts
  EXPECT: 0 fail
  EVIDENCE: Included in the passing suite above; noli-codex retains its native openai-codex-responses transport and origin base URL.
- [x] GW74-SDK: Types, generated schema, extension loading, native controllers and isolated local plugin installation work on the pinned official runtime.
  CHECK: bun run typecheck && bun run schema:check && bun run extension:check && bun run smoke:native && bun scripts/smoke-install.ts --local
  EXPECT: NOLI_RELEASE_INSTALL_OK
  EVIDENCE: All commands passed. The load-only install probe and actual session receive independent bootstrap inputs after one-use environment removal. No external model provider or production credential was used.
- [ ] GW74-RELEASE: Independent review and Ubuntu/macOS CI pass before the orchestrator publishes the stable tag; published installation is verified separately.

## Gateway binding review corrections

- [x] GW74-RV-COMPAT: Legacy clients may reconnect/re-hello without a Gateway catalog; catalog-backed hello remains one-use.
  CHECK: bun test
  EXPECT: 0 fail
  EVIDENCE: bun test passed 250 tests, 0 failures, 1076 assertions on Bun 1.4.2 / SDK 18.8.2; separate legacy replacement-hello and catalog replay-rejection fixtures passed.
- [x] GW74-RV-RENEW: Unexpired keys remain installed during renewal; failures/timeouts back off, actual expiry revokes, successful retry atomically replaces the key.
  CHECK: bun test
  EXPECT: 0 fail
  EVIDENCE: Same passing suite covers delayed reply, rejected renewal with 1s/2s backoff, timeout, actual expiry, ignored late reply and successful replacement using the real SDK registry.
- [x] GW74-RV-BOOTSTRAP: Process-launched factory consumes a private bootstrap file before implicit Bun children can retrieve the secret.
  CHECK: bun test
  EXPECT: 0 fail
  EVIDENCE: Same passing suite launches Bun with only NOLI_BRIDGE_TOKEN_FILE, loads the actual factory and proves the file is gone and implicit child inheritance exposes neither bootstrap env secret nor readable bootstrap path. Symlink/mode rejection and native factory/session lifecycle also pass.
- [x] GW74-RV-INSTALL: Frozen dependencies install without lockfile updates.
  CHECK: bun install --frozen-lockfile
  EXPECT: bun install
  EVIDENCE: bun install --frozen-lockfile passed: 133 installs / 157 packages checked, no changes.
- [x] GW74-RV-TYPES: Pinned TypeScript interfaces accept the completed correction.
  CHECK: bun run typecheck
  EXPECT: tsc --noEmit
  EVIDENCE: bun run typecheck passed (tsc --noEmit).
- [x] GW74-RV-SCHEMA: Protocol schema remains current.
  CHECK: bun run schema:check
  EXPECT: SCHEMA CURRENT
  EVIDENCE: bun run schema:check passed (SCHEMA CURRENT).
- [x] GW74-RV-LOAD: Official SDK loads the extension and consumes its bootstrap file.
  CHECK: bun run extension:check
  EXPECT: EXTENSION LOAD PASSED
  EVIDENCE: bun run extension:check passed (EXTENSION LOAD PASSED).


- [x] GW74-RV-LEGACY-LAUNCH: Non-Gateway launchers retain the released environment-token contract; Gateway catalogs refuse it before registration or bridge startup.
  CHECK: bun test
  EXPECT: 0 fail
  EVIDENCE: bun install --frozen-lockfile, bun test (250 pass / 0 fail / 1076 assertions), typecheck, schema:check and extension:check all passed after this correction; the copied real SDK legacy-launch regression and explicit Gateway refusal fixture passed.


- [x] GW74-PR13: Readiness tracks installed-key expiry, renewal health is safe and visible, long timers respect absolute deadlines, typed bind frames match the schema, and legacy launch authenticates without advertising unavailable binding.
  CHECK: bun test && bun run typecheck && bun run schema:check && bun run extension:check
  EXPECT: EXTENSION LOAD PASSED
  EVIDENCE: bun install --frozen-lockfile passed unchanged. bun test passed 252 tests, 0 failures and 1093 assertions. Typecheck, schema:check (SCHEMA CURRENT) and extension:check (EXTENSION LOAD PASSED) passed. Codacy's one medium/one minor complexity-only findings are non-blocking under project policy; no complexity-only refactor was performed.


- [x] GW74-PR13-R2: A bind reply and same-session adoption in one read share installation and cancellable renewal/expiry timers; id-less unmatched responses fail safely; unconfigured Gateway remains unavailable without false warnings.
  CHECK: bun test && bun run typecheck && bun run schema:check && bun run extension:check
  EXPECT: EXTENSION LOAD PASSED
  EVIDENCE: bun install --frozen-lockfile passed unchanged; bun test passed 254 tests, 0 failures, 1104 assertions. Typecheck, schema:check and extension:check passed. One-write reply/adoption regression proves one renewal/expiry pair and no timer left after invalidation; id-less response regression proves a safe bad_request and subsequent successful request. Warning negative assertions retain the missing-read-tool positive control. README and bootstrap comment now describe disabled setup rather than claiming no guards install.


## Native forge resource producer prerequisite, prepared v0.8.0

- [x] FR1: Authenticated owning-main SDK admission, exact native request shapes, forged authority rejection and revocable results have meaningful regression coverage.
  CHECK: bun test
  EXPECT: 0 fail
  EVIDENCE: automatic-evidence=v1; definition-sha256=2848289c850be8d3ce045ecde828b7a7489811ef4d56388f0fcab104ffd3372d; exit=0; EXPECT=matched; output-sha256=ab09c8d3515d2503d05802294ce2a4879a783ffbc1fc5fc8a4ff4a6a8c3d330f; output-bytes=32799; shell=/bin/sh; cwd=.; source=direct isolated sequential commands; HOME/profile=disposable; output=stdout followed by stderr
- [x] FR2: Pinned official SDK types, optional protocol-1 schema and extension initialization agree.
  CHECK: bun run typecheck && bun run schema:check && bun run extension:check
  EXPECT: EXTENSION LOAD PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=f5aeeb83883225c22a0636a582de14bdcacad36ca7881670ddc503bb00b968b2; exit=0; EXPECT=matched; output-sha256=ed0dd39dd15cd4887c5a0ab9c1699ee26b90b8388dbe23da1716d446cf4f265a; output-bytes=126; shell=/bin/sh; cwd=.; source=direct isolated sequential commands; HOME/profile=disposable; output=stdout followed by stderr per command
- [x] FR3: Disposable official SDK runtime forwards main resolve/read requests and bounded content/errors, cancels through the native RPC adapter, denies unauthorized callers and discards stale content/details.
  CHECK: bun run smoke:forge
  EXPECT: OFFICIAL FORGE PROVENANCE OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=5a48e487e5ced69ecba999b7e504df63f0d538478f8b34696c3f1f4e7e422e96; exit=0; EXPECT=matched; output-sha256=8ab78a8e6f8cb725c16403bbd006ff07310d2f805c2a47aedf2df948dcb82d8b; output-bytes=533; shell=/bin/sh; cwd=.; source=direct isolated sequential commands; HOME/profile=disposable; output=stdout followed by stderr
- [x] FR4: Official CLI local installation discovers the prepared extension and exercises its negotiated forge guard in a disposable HOME/profile.
  CHECK: bun run smoke:install
  EXPECT: NOLI_INSTALLED_FORGE_GUARD_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=0c6931d271e4e676f9cf960ab609d41962fd2072181905b040ecde3684d9a5dc; exit=0; EXPECT=matched; output-sha256=1ccfa56f85ae37a217843734c04248eae61c418cebf42200f0847a4455ecc719; output-bytes=431; shell=/bin/sh; cwd=.; source=direct isolated sequential commands; HOME/profile=disposable; output=stdout followed by stderr

Publication is a developer-only handoff, not a producer implementation check. Independent exact-head Sol review and required Ubuntu/macOS CI must precede merge and stable publication of prepared v0.8.0. Parent confirmed canonical GitHub developer authentication through a sanitized login shell; product code never uses CLI credentials. Published v0.7.1 does not guard `noli_forge_resource`; local installation is not published-tag proof. The parent owns release and actual stable-tag installation. This prerequisite alone does not complete Noli work item 187.

Baseline checkpoint 8dda53f passed 269 tests, 0 failures and 1293 assertions with Bun 1.4.3. Checks used an environment allowlist and disposable HOME/config/data/profile directories so inherited managed Gateway provider keys and auth-broker routes were not test inputs. The first ambient-environment attempt failed three existing SDK tests; the isolated run resolved those failures. Typecheck initially identified missing SDK lifecycle event fields in the new smoke; those were corrected before the successful baseline type/schema/load/native/forge/install run.

PR 15 review reproduced three deterministic consumer failures before the corrections: unrelated secondary hello changed the owning read epoch from 1 to 2; stale error after authenticated adoption was not fenced; and replayed error diagnostics retained their original content/details. The allowlisted disposable-HOME command was `bun test test/thread-control.test.ts test/bridge.test.ts --test-name-pattern 'review forge'`, with 0 pass, 3 fail, 79 filtered out and 13 assertions. Connection-local epochs and unconditional forge-result ownership fencing correct those findings. Final source and official installed-runtime evidence is recorded in FR1–FR4 above.

The final prepared-v0.8.0 run passed 272 tests, 0 failures and 1355 assertions across 14 files. Typecheck, schema check, official extension load, native SDK smoke, extended forge SDK smoke and official disposable local installation all exited zero in one allowlisted pipeline. The native RPC exercise preserved owning reads across secondary hello/disconnect and scrubbed stale success and error content/details after tree/reconnection/adoption. Current backend denial and native cancellation still propagated. Official plugin discovery asserted installed version 0.8.0. This is local-install evidence, not stable-tag publication proof.

The completed review-correction run passed 273 tests, 0 failures and 1361 assertions across 14 files. Typecheck, schema check, official extension load, native SDK smoke, forge SDK smoke and disposable local installation each exited zero. The added preconnected-secondary regression proves socket accept order cannot override the oldest authenticated owning connection. All checks used an environment allowlist and disposable HOME/config/data/cache/profile directories.

Optional early-exit admission cleanup cannot safely use the pinned SDK completion events. `tool_execution_end` carries only toolCallId/toolName/result/isError; `tool_approval_resolved` adds sessionId but no invocation or authentication epoch. ExtensionRunner builds the event context from its live SessionManager. Neither event distinguishes a delayed completion from a newer admission reusing the same call ID, and direct wrapper preflight exits do not themselves emit execution-end. No completion-hook cleanup or manually echoed completion smoke is included. Existing result consumption and switch/branch/tree/shutdown cleanup remain. Safe additional cleanup requires an upstream invocation-specific completion contract; no timer, guessed match or suppressed result substitutes for it.

## Native task tools, prepared v0.9.0

- [x] FT09-SOURCE: Independent review accepts the versioned forge policy and the corrected installed-package consumer oracle without changing protocol 1 or the supported SDK floor.
  EVIDENCE: SolCompanionReleaseSourceReview correction_source_review accepts smoke-install1f1638b8 and installed-runtime1e86e3dc. Production companion code remains the independently reviewed8df source. The local official18.8.2 installation run emitted both legacy and v0.9 policy tokens; this is not downloaded-tag or Noli provider evidence.
- [ ] FT09-RELEASE: The aligned final commit has independent review, required Ubuntu/macOS CI and an immutable artifact for the separately required official18.10.1 native pairing before stable publication.
  EVIDENCE: Commit c3ead4531b48af642c9516e429474cafc9142145 passed required Ubuntu and macOS checks in [CI run 38541389814](https://github.com/MelonSmasher/omp-noli/actions/runs/38541389814). SolCompanionReleaseSourceReview accepted that installed-policy correction. Subsequent invocation-ownership, SDK frame-bound and fresh-seed corrections have source-only Sol review in companion-boundary-review.json and plugin-seed-review.json; their final pushed commit and CI are recorded separately in PR 16. Immutable corrected-artifact admission and genuine official OMP 18.10.1 Noli pairing remain pending, so this release gate stays open. Historical receipts remain unchanged.
- [ ] FT09-INSTALL: Official CLI installation of the published v0.9.0 tag loads downloaded source and exercises all three versioned SDK host tools with authenticated-main and stale/non-SDK denial controls.
  CHECK: bun scripts/smoke-install.ts v0.9.0
  EXPECT: NOLI_INSTALLED_FORGE_V09_POLICY_OK
  CWD: .
  EVIDENCE: Pending stable-tag installation. The earlier local-install pass does not satisfy this gate.

The corrected v0.9.0 checkout passed typecheck, schema consistency, official extension load, all 280 tests across 16 files with 1,619 assertions, native SDK smoke, forge SDK smoke and one local installed-policy run. All seven commands exited zero in an allowlisted disposable HOME/profile. The installed fixture uses the canonical SDK AgentToolResult annotations and exercises the actual installed read/proposal/status handlers on official SDK 18.8.2. This supersedes the TS7022 failure for the changed fixture only. Stable-tag installation and official 18.10.1 Noli pairing remain pending; no native approval, provider mutation or published artifact is claimed.

