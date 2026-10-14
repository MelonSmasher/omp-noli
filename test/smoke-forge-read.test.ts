import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const script = join(import.meta.dir, "../scripts/smoke-forge-read.ts");
const roots: string[] = [];
const sdkVersion = "18.8.2";
const bridgeVersion = "0.9.0";
const bridgeCommit = "a".repeat(40);
const executable = Buffer.from("#!/bin/sh\n# Private seed CLI artifact; never executed.\nexit 0\n");
const executableHash = createHash("sha256").update(executable).digest("hex");

// Only this file's mkdtemp roots are owned and removed; no installed artifacts are used.
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface SeedFixture {
	root: string;
	sdk: string;
	bridge: string;
	sdkFiles: Record<string, string | Buffer>;
	bridgeFiles: Record<string, string | Buffer>;
}

function fixture(invalid?: "name" | "version" | "digest"): SeedFixture {
	const root = mkdtempSync(join(tmpdir(), "noli-read-seed-"));
	roots.push(root);
	const sdkHash = invalid === "digest" ? "0".repeat(64) : executableHash;
	const sdk = join(root, "artifacts", `${sdkVersion}-omp-darwin-arm64-${sdkHash}`);
	const bridge = join(root, "artifacts", `${bridgeVersion}-${bridgeCommit}`);
	const sdkFiles = {
		"omp": executable,
		"sdk-ready.json": JSON.stringify({ version: sdkVersion, sha256: sdkHash }),
		"sdk/package.json": JSON.stringify({ private: true, dependencies: { "@oh-my-pi/pi-coding-agent": sdkVersion } }),
		"sdk/bun.lock": JSON.stringify({ lockfileVersion: 1, workspaces: { "": { dependencies: { "@oh-my-pi/pi-coding-agent": sdkVersion } } } }),
		// The seeder copies, but does not unpack, this CLI-only archive payload.
		"sdk/official-package.tgz": Buffer.from("private seed CLI archive bytes\n"),
		"sdk/node_modules/@oh-my-pi/pi-coding-agent/package.json": JSON.stringify({
			name: invalid === "name" ? "wrong-package" : "@oh-my-pi/pi-coding-agent",
			version: invalid === "version" ? "0.0.0" : sdkVersion,
		}),
		"sdk/node_modules/@oh-my-pi/pi-coding-agent/index.js": "export const seedFixture = true;\n",
	};
	for (const [file, content] of Object.entries(sdkFiles)) {
		const path = join(sdk, file);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, content, { mode: file === "omp" ? 0o700 : 0o600 });
	}
	symlinkSync("@oh-my-pi/pi-coding-agent", join(sdk, "sdk/node_modules/agent-link"));
	const bridgeFiles = {
		"package.json": JSON.stringify({ name: "omp-noli", version: bridgeVersion, type: "module" }),
		"src/index.ts": readFileSync(join(import.meta.dir, "../src/index.ts")),
		"scripts/fixtures/forge-read-runtime.ts": readFileSync(join(import.meta.dir, "../scripts/fixtures/forge-read-runtime.ts")),
	};
	for (const [file, content] of Object.entries(bridgeFiles)) {
		const path = join(bridge, file);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, content, { mode: 0o600 });
	}
	return { root, sdk, bridge, sdkFiles, bridgeFiles };
}

// Includes identities, permissions, bytes and link text without following symlinks.
function snapshot(path: string): unknown {
	const stat = lstatSync(path);
	const identity = { mode: stat.mode, ino: stat.ino, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
	if (stat.isSymbolicLink()) return { ...identity, link: readlinkSync(path) };
	if (stat.isDirectory()) return { ...identity, entries: readdirSync(path).sort().map(name => [name, snapshot(join(path, name))]) };
	return { ...identity, bytes: readFileSync(path).toString("hex") };
}

function savedState(root: string) {
	const data = join(root, "saved-data");
	const generation = join(data, "managed-omp/generations/saved/root");
	mkdirSync(generation, { recursive: true, mode: 0o700 });
	writeFileSync(join(data, "managed-omp/active.json"), '{"format":1,"id":"saved","state_generation":"saved","previous":"retained"}\n', { mode: 0o600 });
	writeFileSync(join(data, "managed-omp/activation.json"), '{"phase":"saved-activation","sentinel":"do-not-replace"}\n', { mode: 0o600 });
	writeFileSync(join(generation, "session.jsonl"), '{"sentinel":"saved-session"}\n', { mode: 0o600 });
	writeFileSync(join(data, "unrelated-state"), "must survive rejection\n", { mode: 0o600 });
	return data;
}

async function seed(f: SeedFixture, data: string) {
	const child = Bun.spawn([process.execPath, "--no-env-file", script, "--seed"], {
		cwd: f.root,
		env: { BUN_BE_BUN: "1", HOME: f.root, NOLI_READ_SEED: JSON.stringify({ data, sdk: f.sdk, bridge: f.bridge }) },
		stdin: "ignore", stdout: "pipe", stderr: "pipe",
	});
	const [exit, stdout, stderr] = await Promise.all([
		child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
	]);
	return { exit, stdout, stderr };
}

test.each(["saved directory", "empty directory", "file", "directory symlink", "file symlink", "dangling symlink"])(
	"seed rejects an existing %s without changing any saved state or artifact",
	async kind => {
		const f = fixture();
		const saved = savedState(f.root);
		const data = kind === "saved directory" ? saved : join(f.root, "data");
		if (kind === "empty directory") mkdirSync(data, { mode: 0o700 });
		if (kind === "file") writeFileSync(data, "destination sentinel\n", { mode: 0o600 });
		if (kind === "directory symlink") symlinkSync(saved, data);
		if (kind === "file symlink") symlinkSync(join(saved, "managed-omp/active.json"), data);
		if (kind === "dangling symlink") symlinkSync(join(f.root, "missing-target"), data);
		const before = snapshot(f.root);
		const result = await seed(f, data);
		expect(result.exit).not.toBe(0);
		expect(result.stderr).toContain("EEXIST");
		expect(result.stdout).toBe("");
		expect(snapshot(f.root)).toEqual(before);
	}, 15_000,
);

test("seed accepts a fresh child and copies verified artifacts without touching neighboring saved state", async () => {
	const f = fixture();
	const saved = savedState(f.root);
	const savedBefore = snapshot(saved);
	const artifactsBefore = snapshot(join(f.root, "artifacts"));
	const data = join(f.root, "data");
	expect(existsSync(data)).toBe(false);
	const result = await seed(f, data);
	expect(result.stderr).toBe("");
	expect(result.exit).toBe(0);
	const release = join(data, "managed-omp/releases", basename(f.sdk));
	const installed = join(data, "bridge-releases", basename(f.bridge));
	expect(JSON.parse(result.stdout)).toEqual({
		sdk_version: sdkVersion, sdk_sha256: executableHash, bridge_version: bridgeVersion, bridge_commit: bridgeCommit,
		sdk_path: join(release, "sdk/node_modules/@oh-my-pi/pi-coding-agent"),
		producer_path: join(installed, "src/index.ts"),
		driver_path: join(installed, "scripts/fixtures/forge-read-runtime.ts"),
	});
	for (const file of Object.keys(f.sdkFiles)) expect(readFileSync(join(release, file))).toEqual(readFileSync(join(f.sdk, file)));
	for (const file of Object.keys(f.bridgeFiles)) expect(readFileSync(join(installed, file))).toEqual(readFileSync(join(f.bridge, file)));
	expect(lstatSync(join(release, "sdk/node_modules/agent-link")).isSymbolicLink()).toBe(true);
	expect(readlinkSync(join(release, "sdk/node_modules/agent-link"))).toBe("@oh-my-pi/pi-coding-agent");
	const activePath = join(data, "managed-omp/active.json");
	const active = JSON.parse(readFileSync(activePath, "utf8"));
	expect(active.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	expect(active).toEqual({
		format: 1, id: active.id,
		binary: { version: sdkVersion, asset: "omp-darwin-arm64", sha256: executableHash },
		bridge_version: bridgeVersion, bridge_commit: bridgeCommit, state_generation: active.id, previous: null,
	});
	expect(readFileSync(join(data, "managed-omp/activation.json"), "utf8")).toBe("null");
	expect(readdirSync(join(data, "managed-omp/generations"))).toEqual([active.id]);
	expect(readdirSync(join(data, "managed-omp/generations", active.id, "root"))).toEqual([]);
	expect(lstatSync(data).mode & 0o777).toBe(0o700);
	expect(lstatSync(activePath).mode & 0o777).toBe(0o600);
	expect(lstatSync(join(data, "managed-omp/activation.json")).mode & 0o777).toBe(0o600);
	expect(snapshot(saved)).toEqual(savedBefore);
	expect(snapshot(join(f.root, "artifacts"))).toEqual(artifactsBefore);

	// A previously successful seed is saved state too, never a reusable destination.
	const beforeRetry = snapshot(f.root);
	const retry = await seed(f, data);
	expect(retry.exit).not.toBe(0);
	expect(retry.stderr).toContain("EEXIST");
	expect(retry.stdout).toBe("");
	expect(snapshot(f.root)).toEqual(beforeRetry);
}, 15_000);

test.each(["name", "version", "digest"] as const)("seed rejects an invalid artifact %s before creating a destination", async invalid => {
	const f = fixture(invalid);
	const data = join(f.root, "data");
	const before = snapshot(f.root);
	const result = await seed(f, data);
	expect(result.exit).not.toBe(0);
	expect(result.stderr).toContain("AssertionError");
	expect(result.stdout).toBe("");
	expect(existsSync(data)).toBe(false);
	expect(snapshot(f.root)).toEqual(before);
}, 15_000);

test("seed does not create missing parent directories", async () => {
	const f = fixture();
	const before = snapshot(f.root);
	const result = await seed(f, join(f.root, "missing-parent/data"));
	expect(result.exit).not.toBe(0);
	expect(result.stderr).toContain("ENOENT");
	expect(result.stdout).toBe("");
	expect(snapshot(f.root)).toEqual(before);
}, 15_000);

test("concurrent seed processes admit exactly one owner of a fresh destination", async () => {
	const f = fixture();
	const data = join(f.root, "data");
	const artifactsBefore = snapshot(join(f.root, "artifacts"));
	const results = await Promise.all([seed(f, data), seed(f, data)]);
	const winner = results.find(result => result.exit === 0);
	const loser = results.find(result => result.exit !== 0);
	expect(winner).toBeDefined();
	expect(loser).toBeDefined();
	expect(winner!.stderr).toBe("");
	expect(JSON.parse(winner!.stdout).sdk_sha256).toBe(executableHash);
	expect(loser!.stderr).toContain("EEXIST");
	expect(loser!.stdout).toBe("");
	const active = JSON.parse(readFileSync(join(data, "managed-omp/active.json"), "utf8"));
	expect(readdirSync(join(data, "managed-omp/generations"))).toEqual([active.id]);
	expect(active.state_generation).toBe(active.id);
	expect(readFileSync(join(data, "managed-omp/activation.json"), "utf8")).toBe("null");
	expect(snapshot(join(f.root, "artifacts"))).toEqual(artifactsBefore);
}, 15_000);
