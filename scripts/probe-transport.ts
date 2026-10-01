/**
 * Transport probe: which local-IPC APIs actually work on this platform under Bun?
 *
 * Each case starts a server, connects a client, sends a frame, waits for the echo, then
 * closes everything it opened. Run by `.github/workflows/windows-probe.yml` to decide how
 * the bridge should listen on Windows. Results print as each case finishes, and the whole
 * run is bounded, so a hung case can't swallow the earlier results. Exits 0 when every case
 * ran (pass or fail); exits 1 only if the run itself had to be cut short.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket, SocketListener } from "bun";

const CASE_TIMEOUT_MS = 5000;
const RUN_TIMEOUT_MS = 60_000;
const PAYLOAD = `ping-${randomBytes(4).toString("hex")}\n`;

// -- Whole-run deadline: print what we have and exit, so leaked handles can't hold the job open.
const runDeadline = setTimeout(() => {
	console.log(`ABORT  run exceeded ${RUN_TIMEOUT_MS} ms; results above are complete, later cases did not run`);
	process.exit(1);
}, RUN_TIMEOUT_MS);

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
	const timer = Promise.withResolvers<never>();
	const handle = setTimeout(() => timer.reject(new Error(`timed out: ${what}`)), CASE_TIMEOUT_MS);
	return Promise.race([promise, timer.promise]).finally(() => clearTimeout(handle));
}

function report(name: string, ok: boolean, detail: string): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Bun.listen / Bun.connect with the `unix` option, which the bridge uses today. */
async function probeBunListen(name: string, path: string): Promise<void> {
	let listener: SocketListener<undefined> | undefined;
	const opened: Socket<undefined>[] = [];
	// A connect that resolves after its timeout is still tracked and closed.
	let pendingConnect: Promise<Socket<undefined>> | undefined;
	try {
		const echoed = Promise.withResolvers<string>();
		listener = Bun.listen<undefined>({
			unix: path,
			socket: {
				open: socket => void opened.push(socket),
				data: (socket, chunk) => void socket.write(chunk),
			},
		});
		pendingConnect = Bun.connect<undefined>({ unix: path, socket: { data: (_s, chunk) => echoed.resolve(chunk.toString()) } });
		pendingConnect.then(client => opened.push(client), () => {});
		const client = await withTimeout(pendingConnect, "Bun.connect");
		client.write(PAYLOAD);
		const got = await withTimeout(echoed.promise, "echo");
		report(name, got === PAYLOAD, got === PAYLOAD ? "round-trip ok" : `wrong echo: ${JSON.stringify(got)}`);
	} catch (error) {
		report(name, false, message(error));
	} finally {
		pendingConnect?.then(client => client.terminate(), () => {});
		for (const socket of opened) socket.terminate();
		listener?.stop(true);
	}
}

/** node:net createServer / connect, the API Node documents for Windows named pipes. */
async function probeNodeNet(name: string, path: string): Promise<void> {
	let server: Server | undefined;
	let client: NetSocket | undefined;
	const accepted: NetSocket[] = [];
	try {
		const listening = Promise.withResolvers<void>();
		server = createServer(socket => {
			accepted.push(socket);
			socket.on("error", () => {});
			socket.on("data", chunk => socket.write(chunk));
		});
		server.once("error", listening.reject);
		server.listen(path, () => listening.resolve());
		await withTimeout(listening.promise, "listen");
		const echoed = Promise.withResolvers<string>();
		client = connect(path);
		client.once("error", echoed.reject);
		client.on("data", chunk => echoed.resolve(chunk.toString()));
		client.write(PAYLOAD);
		const got = await withTimeout(echoed.promise, "echo");
		report(name, got === PAYLOAD, got === PAYLOAD ? "round-trip ok" : `wrong echo: ${JSON.stringify(got)}`);
	} catch (error) {
		report(name, false, message(error));
	} finally {
		// Destroy every connection first; server.close() otherwise waits on them forever.
		client?.destroy();
		for (const socket of accepted) socket.destroy();
		if (server?.listening) {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await withTimeout(closed.promise, "close").catch(error => report(`${name} (cleanup)`, false, message(error)));
		}
	}
}

const pipe = () => `\\\\.\\pipe\\noli-probe-${randomBytes(6).toString("hex")}`;
const dir = mkdtempSync(join(tmpdir(), "noli-probe-"));
const sock = (tag: string) => join(dir, `${tag}.sock`);

console.log(`platform=${process.platform} arch=${process.arch} bun=${Bun.version}`);
try {
	if (process.platform === "win32") {
		await probeBunListen("Bun.listen unix: named pipe", pipe());
		await probeNodeNet("node:net named pipe", pipe());
	}
	// AF_UNIX socket files: native on macOS/Linux; available on Windows 10 1803+ via Winsock.
	await probeBunListen("Bun.listen unix: socket file", sock("bun"));
	await probeNodeNet("node:net socket file", sock("net"));
} finally {
	rmSync(dir, { recursive: true, force: true });
	clearTimeout(runDeadline);
}
// -- Exit explicitly: a handle a runtime failed to release must not keep the job alive.
process.exit(0);
