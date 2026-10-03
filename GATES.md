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
