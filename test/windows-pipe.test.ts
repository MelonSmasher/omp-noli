/**
 * Windows integration: real files, DACLs and named pipes through ./src/windows-native. Skipped
 * elsewhere; the platform-neutral rules are covered by windows-security.test.ts, and the whole
 * bridge suite (bridge.test.ts) runs over the pipe transport on Windows too.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connectPipe,
	consumePrivateFile,
	currentUser,
	EndpointInUseError,
	ensurePrivateDirectory,
	handleSecurity,
	listenPipe,
	NotPrivateError,
	type PipeHandlers,
	type PipeListener,
	type PipeSocket,
	pathSecurity,
	WindowsError,
} from "../src/windows-native";
import { isPipeKey, pipeName, privacyFault, windowsJoin } from "../src/windows-security";

const windows = process.platform === "win32";

function icacls(...args: string[]): void {
	const result = Bun.spawnSync(["icacls", ...args]);
	if (result.exitCode !== 0) throw new Error(`icacls ${args.join(" ")}: ${result.stdout.toString()}${result.stderr.toString()}`);
}

interface Collector {
	handlers: PipeHandlers<undefined>;
	received(): string;
	/** Resolves once everything received equals `expected`. */
	receive(expected: string): Promise<void>;
	/** Resolves at the next `drain`. */
	drained(): Promise<void>;
	closed: Promise<void>;
	opened: Promise<PipeSocket<undefined>>;
}

/** Collects what a pipe end receives, and signals drains and closing. */
function collector(): Collector {
	let text = "";
	let waiting: { expected: string; resolve(): void } | undefined;
	let drain: (() => void) | undefined;
	const closed = Promise.withResolvers<void>();
	const opened = Promise.withResolvers<PipeSocket<undefined>>();
	return {
		handlers: {
			open: socket => opened.resolve(socket),
			data: (_socket, chunk) => {
				text += chunk.toString();
				if (waiting && text === waiting.expected) { waiting.resolve(); waiting = undefined; }
			},
			drain: () => { drain?.(); drain = undefined; },
			close: () => closed.resolve(),
		},
		received: () => text,
		receive(expected) {
			if (text === expected) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiting = { expected, resolve };
			return promise;
		},
		drained() {
			const { promise, resolve } = Promise.withResolvers<void>();
			drain = resolve;
			return promise;
		},
		closed: closed.promise,
		opened: opened.promise,
	};
}

/** Writes everything, continuing after each drain the way the bridge's flush does. */
async function writeAll(socket: PipeSocket<undefined>, events: Collector, bytes: Buffer): Promise<void> {
	let rest = bytes;
	for (;;) {
		rest = rest.subarray(socket.write(rest));
		if (!rest.length) return;
		await events.drained();
	}
}

describe.skipIf(!windows)("Windows named-pipe listener (noli_platform::ipc contract)", () => {
	let dir: string;
	let path: string;
	let listener: PipeListener | undefined;
	const refusal = (reason: string) => Buffer.from(`refused: ${reason}\n`);
	const failed = (error: Error) => { throw error; };

	beforeEach(() => {
		dir = join(mkdtempSync(join(tmpdir(), "noli-pipe-")), "bridge");
		ensurePrivateDirectory(dir);
		path = windowsJoin(dir, "omp-1.sock");
	});
	afterEach(() => {
		listener?.stop(true);
		listener = undefined;
		rmSync(join(dir, ".."), { recursive: true, force: true });
	});

	test("publishes a private key file naming a pipe owned by and granting only this user", async () => {
		const server = collector();
		listener = listenPipe(path, server.handlers, { refusal, failed });
		const key = readFileSync(path, "utf8");
		expect(isPipeKey(key)).toBe(true);
		expect(listener.pipeName).toBe(pipeName(path, key));
		expect(privacyFault(pathSecurity(path), currentUser())).toBeUndefined();
		const client = collector();
		const socket = await connectPipe(path, client.handlers);
		const pipe = handleSecurity(socket.handle, true);
		expect(pipe.owner).toBe(currentUser().user);
		// Strictly the user: no SYSTEM or Administrators grant on the pipe itself.
		expect(privacyFault(pipe, { user: currentUser().user, defaultOwner: currentUser().user })).toBeUndefined();
		socket.terminate();
	});

	test("bytes flow both ways; end() delivers what was written before end of stream", async () => {
		const server = collector();
		listener = listenPipe(path, server.handlers, { refusal, failed });
		const client = collector();
		const socket = await connectPipe(path, client.handlers);
		const accepted = await server.opened;
		expect(socket.write(Buffer.from("ping\n"))).toBe(5);
		await server.receive("ping\n");
		// More than the pipe buffer: a write goes pending, and the rest follows its drain.
		const big = "x".repeat(300 * 1024);
		await writeAll(accepted, server, Buffer.from(`${big}last\n`));
		accepted.end();
		await client.closed;
		expect(client.received()).toBe(`${big}last\n`);
		await server.closed;
	});

	test("serves several clients, each on its own instance", async () => {
		const accepted: PipeSocket<undefined>[] = [];
		const server = collector();
		listener = listenPipe(path, { ...server.handlers, open: socket => void accepted.push(socket), data: (socket, chunk) => void socket.write(chunk) }, { refusal, failed });
		const clients = [collector(), collector(), collector()];
		// Three clients at once: all but one find every instance busy and retry, as noli_platform's client does.
		const sockets = await Promise.all(clients.map(client => connectPipe(path, client.handlers)));
		sockets.forEach((socket, index) => socket.write(Buffer.from(`c${index}\n`)));
		await Promise.all(clients.map((client, index) => client.receive(`c${index}\n`)));
		expect(accepted.length).toBe(3);
		for (const socket of sockets) socket.end();
		await Promise.all(clients.map(client => client.closed));
	});

	test("an endpoint in use cannot be bound twice, and stop() frees it for a replacement", async () => {
		listener = listenPipe(path, collector().handlers, { refusal, failed });
		expect(() => listenPipe(path, collector().handlers, { refusal, failed })).toThrow(EndpointInUseError);
		const name = listener.pipeName;
		listener.stop(true);
		listener = undefined;
		expect(existsSync(path)).toBe(false);
		// The old pipe is gone, not just unpublished.
		await expect(connectPipe(path, collector().handlers)).rejects.toThrow();
		expect(() => readFileSync(name)).toThrow(/ENOENT|no such file/i);
		listener = listenPipe(path, collector().handlers, { refusal, failed });
		const client = collector();
		(await connectPipe(path, client.handlers)).end();
		await client.closed;
	});

	test("stop() keeps a key file a replacement listener has already published", () => {
		listener = listenPipe(path, collector().handlers, { refusal, failed });
		const ours = readFileSync(path, "utf8");
		rmSync(path);
		const replacement = listenPipe(path, collector().handlers, { refusal, failed });
		try {
			listener.stop(true);
			listener = undefined;
			const theirs = readFileSync(path, "utf8");
			expect(theirs).not.toBe(ours);
			expect(isPipeKey(theirs)).toBe(true);
		} finally { replacement.stop(true); }
	});

	test("remote clients are rejected: the same pipe through the SMB loopback is refused", async () => {
		const remote = (name: string) => name.replace("\\\\.\\", "\\\\localhost\\");
		// Negative control: a libuv pipe (default DACL, no PIPE_REJECT_REMOTE_CLIENTS) is reachable that way.
		const controlName = `\\\\.\\pipe\\noli-control-${process.pid}`;
		const control = createServer(socket => socket.destroy());
		const listening = Promise.withResolvers<void>();
		control.listen(controlName, listening.resolve);
		await listening.promise;
		try { closeSync(openSync(remote(controlName), "r+")); }
		finally { control.close(); }
		listener = listenPipe(path, collector().handlers, { refusal, failed });
		expect(remote(listener.pipeName).startsWith("\\\\localhost\\pipe\\noli-")).toBe(true);
		expect(() => openSync(remote(listener!.pipeName), "r+")).toThrow(/EPERM|operation not permitted/);
		// The same pipe locally is fine.
		closeSync(openSync(listener.pipeName, "r+"));
	});
});

describe.skipIf(!windows)("Windows private-file checks (noli_platform::fs rule)", () => {
	let root: string;
	let dir: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "noli-private-"));
		dir = join(root, "bridge");
		ensurePrivateDirectory(dir);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("a missing bridge dir is created owner-only, the way Noli's set_private makes one", () => {
		const security = pathSecurity(dir);
		expect(privacyFault(security, currentUser())).toBeUndefined();
		const fresh = join(dir, "inner");
		writeFileSync(fresh, "x");
		// The grant is inheritable: files created inside start private.
		expect(privacyFault(pathSecurity(fresh), currentUser())).toBeUndefined();
	});

	test("a shared bridge dir is refused", () => {
		icacls(dir, "/grant", "*S-1-1-0:(R)");
		expect(() => ensurePrivateDirectory(dir)).toThrow(/must not be accessible to other users \(DACL grants S-1-1-0\)/);
	});

	test("a junction is not a bridge dir", () => {
		const link = join(root, "link");
		const made = Bun.spawnSync(["cmd", "/c", "mklink", "/J", link, dir]);
		expect(made.exitCode).toBe(0);
		expect(() => ensurePrivateDirectory(link)).toThrow(NotPrivateError);
		expect(() => ensurePrivateDirectory(link)).toThrow(/not a real directory/);
	});

	test("the bootstrap file is read once and removed", () => {
		const file = join(dir, "bridge-bootstrap.token");
		writeFileSync(file, "secret-token");
		expect(consumePrivateFile(file)).toBe("secret-token");
		expect(existsSync(file)).toBe(false);
	});

	test.each([
		["shared with Everyone", (file: string) => icacls(file, "/grant", "*S-1-1-0:(R)"), /must not be accessible to other users/],
		["hard-linked", (file: string) => linkSync(file, `${file}.alias`), /more than one name/],
		["empty", (file: string) => writeFileSync(file, ""), /size outside/],
		["too large", (file: string) => writeFileSync(file, "x".repeat(4097)), /size outside/],
	])("a bootstrap file %s is refused and left in place", (_label, spoil, message) => {
		const file = join(dir, "bridge-bootstrap.token");
		writeFileSync(file, "secret-token");
		spoil(file);
		expect(() => consumePrivateFile(file)).toThrow(message);
		expect(() => consumePrivateFile(file)).toThrow(NotPrivateError);
		expect(existsSync(file)).toBe(true);
	});

	test("a directory is not a bootstrap file", () => {
		const inner = join(dir, "inner");
		mkdirSync(inner);
		expect(() => consumePrivateFile(inner)).toThrow(/is a directory/);
	});

	test("a missing bootstrap file is a typed Win32 error", () => {
		expect(() => consumePrivateFile(join(dir, "absent"))).toThrow(WindowsError);
	});
});
