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

