/**
 * Win32 through `bun:ffi`: the private-file checks and the named-pipe transport Noli's
 * `noli_platform` expects on Windows. Libraries load on first use, so importing this module
 * is free on macOS and Linux; nothing here may be called there.
 *
 * Why FFI rather than `node:net`/`Bun.listen`: neither can give a pipe a security descriptor,
 * `FILE_FLAG_FIRST_PIPE_INSTANCE` or `PIPE_REJECT_REMOTE_CLIENTS`. Why not a helper binary:
 * Noli installs omp-noli from its source archive and accepts no native payloads or install
 * hooks, so a helper would need its own per-architecture release and trust chain.
 *
 * Pipe I/O is asynchronous: handles are overlapped, and reads, writes and listens go through
 * `NtReadFile`/`NtWriteFile`/`NtFsControlFile`, which return the NTSTATUS directly (no
 * `GetLastError` racing the JS engine), with an event per operation. One worker thread blocks
 * in `WaitForMultipleObjects` on the armed events and posts which one fired (./windows-waiter).
 * I/O buffers and status blocks live in process-heap memory that stays put until the kernel
 * has completed the operation.
 */
import { dlopen, FFIType, type Pointer, read, toArrayBuffer } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	type CurrentUser,
	describeFault,
	isPipeKey,
	type ObjectSecurity,
	pipeName,
	privacyFault,
	privateFileSddl,
	privatePipeSddl,
	sidLength,
	sidString,
} from "./windows-security";

/** A Win32 failure, with its error code when the system reported one. */
export class WindowsError extends Error {
	constructor(readonly operation: string, readonly code: number, detail?: string) {
		super(`${operation} failed${code ? ` (Win32 error ${code})` : ""}${detail ? `: ${detail}` : ""}`);
	}
}

/** A path, directory or pipe that is not private to the current user. */
export class NotPrivateError extends Error {
	constructor(readonly reason: "link" | "not_directory" | "not_file" | "links" | "size" | "owner" | "shared" | "pipe_owner" | "peer", message: string) {
		super(message);
	}
}

/** The endpoint already has a key file: another listener owns it, or a stale one was left behind. */
export class EndpointInUseError extends Error {
	readonly code = "EADDRINUSE";
}

const { ptr: P, i64_fast: H, u32: U32, i32: I32, u64: U64 } = FFIType;
type Handle = number;

const GENERIC_READ = 0x8000_0000;
const GENERIC_WRITE = 0x4000_0000;
const DELETE = 0x0001_0000;
const READ_CONTROL = 0x0002_0000;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_SHARE_ALL = 0x1 | 0x2 | 0x4;
const CREATE_NEW = 1;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const FILE_FLAG_OVERLAPPED = 0x4000_0000;
/** A path that names a pipe may only identify this process, never impersonate it. */
const SQOS_IDENTIFICATION = 0x0010_0000 | 0x0001_0000;
const PIPE_ACCESS_DUPLEX = 0x3;
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x0008_0000;
const PIPE_REJECT_REMOTE_CLIENTS = 0x8;
const PIPE_UNLIMITED_INSTANCES = 255;
/** tokio's `ServerOptions` defaults, which `noli_platform` uses. */
const PIPE_BUFFER_BYTES = 65_536;
const SE_FILE_OBJECT = 1;
const SE_KERNEL_OBJECT = 6;
const OWNER_SECURITY_INFORMATION = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
const TOKEN_QUERY = 0x8;
const TOKEN_USER = 1;
const TOKEN_OWNER = 4;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const FILE_DISPOSITION_INFO = 4;
const FILE_DISPOSITION_INFO_EX = 21;
const FILE_DISPOSITION_DELETE_POSIX = 0x1 | 0x2;
const FSCTL_PIPE_LISTEN = 0x0011_0008;
const INVALID_HANDLE = -1;

const STATUS_PENDING = 0x103;
const STATUS_PIPE_CONNECTED = 0xc000_00b2 | 0;
/** A connection ending: the peer closed, or this end cancelled or closed its own I/O. */
const STATUS_ENDED = new Set([0xc000_014b, 0xc000_00b0, 0xc000_00b1, 0xc000_0120, 0xc000_0011].map(status => status | 0));

/** Loads the libraries on first use; only ever called on Windows. */
function lazy<T>(make: () => T): () => T {
	let value: T | undefined;
	return () => (value ??= make());
}

const win = lazy(() => {
	if (process.platform !== "win32") throw new Error("Windows security APIs are only available on Windows");
	const kernel32 = dlopen("kernel32.dll", {
		GetLastError: { args: [], returns: U32 },
		CloseHandle: { args: [H], returns: I32 },
		CreateFileW: { args: [P, U32, U32, P, U32, U32, H], returns: H },
		CreateDirectoryW: { args: [P, P], returns: I32 },
		ReadFile: { args: [H, P, U32, P, P], returns: I32 },
		WriteFile: { args: [H, P, U32, P, P], returns: I32 },
		FlushFileBuffers: { args: [H], returns: I32 },
		GetFileInformationByHandle: { args: [H, P], returns: I32 },
		SetFileInformationByHandle: { args: [H, I32, P, U32], returns: I32 },
		CreateNamedPipeW: { args: [P, U32, U32, U32, U32, U32, U32, P], returns: H },
		GetNamedPipeClientProcessId: { args: [H, P], returns: I32 },
		CancelIoEx: { args: [H, P], returns: I32 },
		CreateEventW: { args: [P, I32, I32, P], returns: H },
		SetEvent: { args: [H], returns: I32 },
		GetCurrentProcess: { args: [], returns: H },
		OpenProcess: { args: [U32, I32, U32], returns: H },
		GetProcessHeap: { args: [], returns: H },
		HeapAlloc: { args: [H, U32, U64], returns: P },
		HeapFree: { args: [H, U32, P], returns: I32 },
		LocalFree: { args: [P], returns: P },
	});
	const advapi32 = dlopen("advapi32.dll", {
		OpenProcessToken: { args: [H, U32, P], returns: I32 },
		GetTokenInformation: { args: [H, I32, P, U32, P], returns: I32 },
		GetSecurityInfo: { args: [H, I32, U32, P, P, P, P, P], returns: U32 },
		ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [P, U32, P, P], returns: I32 },
	});
	const ntdll = dlopen("ntdll.dll", {
		NtReadFile: { args: [H, H, P, P, P, P, U32, P, P], returns: I32 },
		NtWriteFile: { args: [H, H, P, P, P, P, U32, P, P], returns: I32 },
		NtFsControlFile: { args: [H, H, P, P, P, U32, P, U32, P, U32], returns: I32 },
	});
	return { ...kernel32.symbols, ...advapi32.symbols, ...ntdll.symbols };
});

function fail(operation: string, detail?: string): never {
	// Best effort: the engine may touch the thread's last error between two FFI calls.
	throw new WindowsError(operation, win().GetLastError(), detail);
}

const wide = (text: string): Buffer => Buffer.from(`${text}\0`, "utf16le");

/** Reads a pointer-sized out-parameter. */
const outPointer = (cell: BigUint64Array): number => Number(cell[0]);

/** A security descriptor parsed from SDDL, freed by `release`. */
class SecurityDescriptor {
	readonly attributes: Buffer;
	#pointer: number;
	constructor(sddl: string) {
		const out = new BigUint64Array(1);
		if (!win().ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl), 1, out, null)) fail("ConvertStringSecurityDescriptorToSecurityDescriptorW", sddl);
		this.#pointer = outPointer(out);
		// SECURITY_ATTRIBUTES: nLength, (padding), lpSecurityDescriptor, bInheritHandle.
		this.attributes = Buffer.alloc(24);
		this.attributes.writeUInt32LE(24, 0);
		this.attributes.writeBigUInt64LE(BigInt(this.#pointer), 8);
	}
	release(): void {
		if (this.#pointer) win().LocalFree(this.#pointer as Pointer);
		this.#pointer = 0;
	}
}

function tokenSid(process: Handle, kind: number): string {
	const w = win();
	const token = new BigUint64Array(1);
	if (!w.OpenProcessToken(process, TOKEN_QUERY, token)) fail("OpenProcessToken");
	const handle = outPointer(token);
	try {
		// TOKEN_USER / TOKEN_OWNER start with a pointer to the SID, stored later in the same buffer.
		const buffer = new BigUint64Array(64);
		const length = new Uint32Array(1);
		if (!w.GetTokenInformation(handle, kind, buffer, buffer.byteLength, length)) fail("GetTokenInformation");
		const sid = Number(buffer[0]);
		const bytes = new Uint8Array(toArrayBuffer(sid as Pointer, 0, 8 + 4 * read.u8(sid as Pointer, 1)));
		const text = sidString(bytes);
		if (text === undefined) throw new WindowsError("GetTokenInformation", 0, "malformed SID");
		return text;
	} finally {
		w.CloseHandle(handle);
	}
}

let current: CurrentUser | undefined;
/** This process's user SID and default owner. Cached: a process's user never changes. */
export function currentUser(): CurrentUser {
	if (current) return current;
	const self = Number(win().GetCurrentProcess());
	current = { user: tokenSid(self, TOKEN_USER), defaultOwner: tokenSid(self, TOKEN_OWNER) };
	return current;
}

/** The owner and DACL of the object `handle` refers to; the handle needs READ_CONTROL. */
export function handleSecurity(handle: Handle, kernelObject: boolean): ObjectSecurity {
	const w = win();
	const owner = new BigUint64Array(1);
	const dacl = new BigUint64Array(1);
	const descriptor = new BigUint64Array(1);
	const status = w.GetSecurityInfo(handle, kernelObject ? SE_KERNEL_OBJECT : SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, owner, null, dacl, null, descriptor);
	if (status !== 0) throw new WindowsError("GetSecurityInfo", status);
	try {
		const ownerPointer = outPointer(owner) as Pointer;
		const ownerBytes = new Uint8Array(toArrayBuffer(ownerPointer, 0, sidLength(new Uint8Array(toArrayBuffer(ownerPointer, 0, 2)))));
		const ownerSid = sidString(ownerBytes);
		if (ownerSid === undefined) throw new WindowsError("GetSecurityInfo", 0, "malformed owner SID");
		const daclPointer = outPointer(dacl);
		// Copy the ACL out (AclSize is at offset 2) before the descriptor is freed.
		const aclBytes = daclPointer === 0 ? null : new Uint8Array(toArrayBuffer(daclPointer as Pointer, 0, read.u16(daclPointer as Pointer, 2))).slice();
		return { owner: ownerSid, dacl: aclBytes };
	} finally {
		w.LocalFree(outPointer(descriptor) as Pointer);
	}
}

interface FileFacts {
	attributes: number;
	links: number;
	size: number;
}

function fileFacts(handle: Handle): FileFacts {
	// BY_HANDLE_FILE_INFORMATION: attributes at 0, size high/low at 32/36, link count at 40.
	const info = Buffer.alloc(52);
	if (!win().GetFileInformationByHandle(handle, info)) fail("GetFileInformationByHandle");
	return { attributes: info.readUInt32LE(0), links: info.readUInt32LE(40), size: info.readUInt32LE(32) * 2 ** 32 + info.readUInt32LE(36) };
}

function openPath(path: string, access: number, flags: number, disposition = OPEN_EXISTING, attributes: Buffer | null = null): Handle {
	const handle = Number(win().CreateFileW(wide(path), access, FILE_SHARE_ALL, attributes, disposition, flags | SQOS_IDENTIFICATION, 0));
	if (handle === INVALID_HANDLE) fail("CreateFileW", path);
	return handle;
}

function requirePrivate(what: string, security: ObjectSecurity): void {
	const fault = privacyFault(security, currentUser());
	if (fault) throw new NotPrivateError(fault.kind === "owner" ? "owner" : "shared", `${what} ${describeFault(fault)}`);
}

/** Deletes the file `handle` opened (with DELETE access), so the object checked is the one removed. */
function deleteByHandle(handle: Handle): void {
	const w = win();
	const flags = new Uint32Array([FILE_DISPOSITION_DELETE_POSIX]);
	if (w.SetFileInformationByHandle(handle, FILE_DISPOSITION_INFO_EX, flags, 4)) return;
	// Older systems and file systems without POSIX deletes.
	if (!w.SetFileInformationByHandle(handle, FILE_DISPOSITION_INFO, new Uint8Array([1]), 1)) fail("SetFileInformationByHandle");
}

function readAll(handle: Handle, size: number): Buffer {
	const buffer = Buffer.alloc(size);
	const done = new Uint32Array(1);
	let offset = 0;
	while (offset < size) {
		if (!win().ReadFile(handle, buffer.subarray(offset), size - offset, done, null)) fail("ReadFile");
		if (done[0] === 0) break;
		offset += done[0]!;
	}
	return buffer.subarray(0, offset);
}

/**
 * Reads and removes Noli's one-use bootstrap file: a regular file, not a link, with one name,
 * 1..4096 bytes, owned by this user and private to it. Every check reads the opened handle,
 * and the same handle deletes the file, so nothing can be swapped in between.
 */
export function consumePrivateFile(path: string): string {
	const w = win();
	// Backup semantics opens a directory too, so it is refused as one rather than as access denied.
	const handle = openPath(path, GENERIC_READ | DELETE, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
	try {
		const facts = fileFacts(handle);
		if (facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT) throw new NotPrivateError("link", "Invalid Noli bootstrap file: it is a link");
		if (facts.attributes & FILE_ATTRIBUTE_DIRECTORY) throw new NotPrivateError("not_file", "Invalid Noli bootstrap file: it is a directory");
		if (facts.links !== 1) throw new NotPrivateError("links", "Invalid Noli bootstrap file: it has more than one name");
		if (facts.size < 1 || facts.size > 4096) throw new NotPrivateError("size", "Invalid Noli bootstrap file: size outside 1..4096 bytes");
		requirePrivate("Invalid Noli bootstrap file: it", handleSecurity(handle, false));
		try { return readAll(handle, facts.size).toString("utf8"); }
		finally { deleteByHandle(handle); }
	} finally {
		w.CloseHandle(handle);
	}
}

/**
 * Creates `dir` private (an inheritable owner-only DACL, as Noli's `set_private`) if absent,
 * then requires a real directory, not a link, owned by this user and private to it.
 */
export function ensurePrivateDirectory(dir: string): void {
	const w = win();
	if (!existsSync(dir)) {
		mkdirSync(dirname(dir), { recursive: true });
		const descriptor = new SecurityDescriptor(privateFileSddl(currentUser().user, true));
		try {
			if (!w.CreateDirectoryW(wide(dir), descriptor.attributes) && !existsSync(dir)) fail("CreateDirectoryW", dir);
		} finally { descriptor.release(); }
	}
	const handle = openPath(dir, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
	try {
		const { attributes } = fileFacts(handle);
		if (attributes & FILE_ATTRIBUTE_REPARSE_POINT || !(attributes & FILE_ATTRIBUTE_DIRECTORY)) {
			throw new NotPrivateError(attributes & FILE_ATTRIBUTE_REPARSE_POINT ? "link" : "not_directory", `bridge dir ${dir} is not a real directory`);
		}
		requirePrivate(`bridge dir ${dir}`, handleSecurity(handle, false));
	} finally {
		w.CloseHandle(handle);
	}
}

/** Owner and DACL of a path without following a final link (tests and diagnostics). */
export function pathSecurity(path: string): ObjectSecurity {
	const handle = openPath(path, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
	try { return handleSecurity(handle, false); }
	finally { win().CloseHandle(handle); }
}

// -- Process-heap memory for I/O the kernel completes later.

let heap: Handle | undefined;
function alloc(bytes: number): Pointer {
	heap ??= Number(win().GetProcessHeap());
	// Declared as `ptr`; Bun's typings widen it with bigint.
	const pointer = win().HeapAlloc(heap, 0x8 /* HEAP_ZERO_MEMORY */, bytes) as Pointer | null;
	if (!pointer) throw new WindowsError("HeapAlloc", 0, `${bytes} bytes`);
	return pointer;
}
function free(pointer: Pointer): void {
	win().HeapFree(heap!, 0, pointer);
}

// -- The waiter: one worker blocked on the armed events; see ./windows-waiter.

const WAIT_SLOTS = 63;

class Waiter {
	readonly #worker: Worker;
	readonly #wake: Handle;
	readonly #armed: Int32Array;
	readonly #events: BigInt64Array;
	readonly #callbacks: Array<(() => void) | undefined> = new Array(WAIT_SLOTS).fill(undefined);
	constructor() {
		const w = win();
		this.#wake = Number(w.CreateEventW(null, 0, 0, null));
		if (!this.#wake) fail("CreateEventW");
		const shared = new SharedArrayBuffer(WAIT_SLOTS * 12);
		this.#events = new BigInt64Array(shared, 0, WAIT_SLOTS);
		this.#armed = new Int32Array(shared, WAIT_SLOTS * 8, WAIT_SLOTS);
		this.#worker = new Worker(new URL("./windows-waiter.ts", import.meta.url).href);
		this.#worker.onmessage = (event: MessageEvent<number | string>) => {
			if (typeof event.data === "string") { console.error(`omp-noli: pipe waiter stopped: ${event.data}`); return; }
			const callback = this.#callbacks[event.data];
			this.#callbacks[event.data] = undefined;
			callback?.();
		};
		this.#worker.postMessage({ shared, wake: this.#wake, slots: WAIT_SLOTS });
		// The bridge never keeps OMP alive; a blocked native wait ends with the process.
		// Bun's Worker has unref(), which its DOM-shaped typings omit.
		(this.#worker as Worker & { unref(): void }).unref();
	}
	/** Runs `callback` once `event` is signalled. False when every slot is in use. */
	arm(event: Handle, callback: () => void): boolean {
		const slot = this.#callbacks.indexOf(undefined);
		if (slot === -1) return false;
		this.#callbacks[slot] = callback;
		Atomics.store(this.#events, slot, BigInt(event));
		Atomics.store(this.#armed, slot, 1);
		win().SetEvent(this.#wake);
		return true;
	}
}
let waiter: Waiter | undefined;

/** One overlapped operation: its status block, event and buffer, freed once the kernel is done. */
class Operation {
	readonly event: Handle;
	readonly status: Pointer;
	readonly buffer: Pointer | null;
	constructor(readonly bufferBytes: number) {
		this.event = Number(win().CreateEventW(null, 1, 0, null));
		if (!this.event) fail("CreateEventW");
		this.status = alloc(16);
		this.buffer = bufferBytes ? alloc(bufferBytes) : null;
	}
	/** IO_STATUS_BLOCK: the NTSTATUS, then the byte count. */
	result(): { status: number; bytes: number } {
		return { status: read.i32(this.status, 0), bytes: Number(read.u64(this.status, 8)) };
	}
	/** Calls `done` when the operation that returned STATUS_PENDING completes. */
	wait(done: () => void): void {
		waiter ??= new Waiter();
		if (!waiter.arm(this.event, done)) throw new WindowsError("WaitForMultipleObjects", 0, `more than ${WAIT_SLOTS} pending pipe operations`);
	}
	release(): void {
		win().CloseHandle(this.event);
		free(this.status);
		if (this.buffer) free(this.buffer);
	}
}

// -- Pipe connections, shaped like the subset of Bun's Socket the bridge uses.

export interface PipeHandlers<T> {
	open(socket: PipeSocket<T>): void;
	data(socket: PipeSocket<T>, chunk: Buffer): void;
	drain(socket: PipeSocket<T>): void;
	close(socket: PipeSocket<T>): void;
	error?(socket: PipeSocket<T>, error: Error): void;
}

const IO_BYTES = PIPE_BUFFER_BYTES;

export class PipeSocket<T = undefined> {
	data!: T;
	#handle: Handle;
	readonly #handlers: PipeHandlers<T>;
	#reader?: Operation;
	#writer?: Operation;
	#reading = false;
	#writing = false;
	#ending = false;
	#closed = false;

	constructor(handle: Handle, handlers: PipeHandlers<T>) {
		this.#handle = handle;
		this.#handlers = handlers;
	}

	/** The pipe handle, for security queries; invalid once closed. */
	get handle(): Handle { return this.#handle; }

	/** Opens the connection: calls `open`, then reads until the peer closes. */
	start(): void {
		this.#handlers.open(this);
		this.#read();
	}

	#read(): void {
		this.#reader ??= new Operation(IO_BYTES);
		const op = this.#reader;
		while (!this.#closed) {
			const status = win().NtReadFile(this.#handle, op.event, null, null, op.status, op.buffer, IO_BYTES, null, null);
			if (status === STATUS_PENDING) {
				this.#reading = true;
				op.wait(() => {
					this.#reading = false;
					const result = op.result();
					if (this.#closed) { this.#release(); return; }
					if (this.#received(result.status, result.bytes)) this.#read();
				});
				return;
			}
			if (!this.#received(status, status >= 0 ? op.result().bytes : 0)) return;
		}
	}

	/** Delivers a completed read; false when the connection ended. */
	#received(status: number, bytes: number): boolean {
		if (status < 0) {
			this.#finish(STATUS_ENDED.has(status) ? undefined : new WindowsError("NtReadFile", 0, `NTSTATUS 0x${(status >>> 0).toString(16)}`));
			return false;
		}
		if (bytes > 0) this.#handlers.data(this, Buffer.from(new Uint8Array(toArrayBuffer(this.#reader!.buffer!, 0, bytes))));
		return !this.#closed;
	}

	/**
	 * Bun semantics: returns how many bytes were taken (0 once closed or while a write is in
	 * flight). Taken bytes are on their way; after a short count, `drain` follows.
	 */
	write(bytes: Uint8Array | string): number {
		if (this.#closed || this.#ending || this.#writing) return 0;
		const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
		this.#writer ??= new Operation(IO_BYTES);
		const op = this.#writer;
		let taken = 0;
		while (taken < data.length) {
			const chunk = Math.min(IO_BYTES, data.length - taken);
			new Uint8Array(toArrayBuffer(op.buffer!, 0, chunk)).set(data.subarray(taken, taken + chunk));
			const status = win().NtWriteFile(this.#handle, op.event, null, null, op.status, op.buffer, chunk, null, null);
			if (status === STATUS_PENDING) {
				this.#writing = true;
				op.wait(() => {
					this.#writing = false;
					const { status: final } = op.result();
					if (this.#closed) { this.#release(); return; }
					if (final < 0) { this.#finish(STATUS_ENDED.has(final) ? undefined : new WindowsError("NtWriteFile", 0, `NTSTATUS 0x${(final >>> 0).toString(16)}`)); return; }
					if (this.#ending) { this.#finish(); return; }
					this.#handlers.drain(this);
				});
				return taken + chunk;
			}
			if (status < 0) {
				queueMicrotask(() => this.#finish(STATUS_ENDED.has(status) ? undefined : new WindowsError("NtWriteFile", 0, `NTSTATUS 0x${(status >>> 0).toString(16)}`)));
				return taken;
			}
			taken += op.result().bytes;
		}
		return taken;
	}

	/** Closes once written data has been handed to the pipe; the peer still reads it, then end of stream. */
	end(): void {
		if (this.#closed || this.#ending) return;
		this.#ending = true;
		if (!this.#writing) this.#finish();
	}

	/** Closes now, abandoning a write in flight. */
	terminate(): void {
		this.#finish();
	}

	/**
	 * Closes the handle without `DisconnectNamedPipe`, which would discard data the peer
	 * hasn't read. Pending operations complete as cancelled and release their memory then.
	 */
	#finish(error?: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		const w = win();
		if (this.#reading || this.#writing) w.CancelIoEx(this.#handle, null);
		w.CloseHandle(this.#handle);
		this.#release();
		queueMicrotask(() => {
			if (error) this.#handlers.error?.(this, error);
			this.#handlers.close(this);
		});
	}

	#release(): void {
		if (!this.#reading && this.#reader) { this.#reader.release(); this.#reader = undefined; }
		if (!this.#writing && this.#writer) { this.#writer.release(); this.#writer = undefined; }
	}
}

// -- The listener.

function processUser(pid: number): string {
	const w = win();
	const process = Number(w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
	if (!process) fail("OpenProcess", `client process ${pid}`);
	try { return tokenSid(process, TOKEN_USER); }
	finally { w.CloseHandle(process); }
}

/** The user the client at the other end of a server pipe runs as (`noli_platform` `peer`). */
export function clientUser(handle: Handle): string {
	const pid = new Uint32Array(1);
	if (!win().GetNamedPipeClientProcessId(handle, pid)) fail("GetNamedPipeClientProcessId");
	return processUser(pid[0]!);
}

function createInstance(name: string, descriptor: SecurityDescriptor, first: boolean): Handle {
	const handle = Number(win().CreateNamedPipeW(
		wide(name),
		PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
		PIPE_REJECT_REMOTE_CLIENTS,
		PIPE_UNLIMITED_INSTANCES,
		PIPE_BUFFER_BYTES,
		PIPE_BUFFER_BYTES,
		0,
		descriptor.attributes,
	));
	if (handle === INVALID_HANDLE) fail("CreateNamedPipeW", first ? `${name} (first instance: refused if the name is taken)` : name);
	return handle;
}

export interface PipeListenerOptions {
	/** Frame written to a client that runs as another user before it is disconnected. */
	refusal(reason: string): Buffer;
	/** Accepting stopped for good (for example, no new pipe instance could be created). */
	failed(error: Error): void;
}

export interface PipeListener {
	readonly pipeName: string;
	stop(closeActiveConnections?: boolean): void;
}

/** Deletes the key file at `path` if it still holds `key`, comparing and deleting through one handle. */
function removeKeyFile(path: string, key: string): void {
	let handle: Handle;
	try { handle = openPath(path, GENERIC_READ | DELETE, FILE_FLAG_OPEN_REPARSE_POINT); }
	catch { return; }
	try {
		if (readAll(handle, key.length + 1).toString("utf8").trim() === key) deleteByHandle(handle);
	} finally { win().CloseHandle(handle); }
}

/**
 * Listens at `path` the way `noli_platform::ipc::NamedPipes::bind` does: claims the path with
 * a new private key file (refused if one exists), creates the first instance of
 * `\\.\pipe\noli-<sha256(path)>-<key>` (owned by and granting only this user, rejecting remote
 * clients, refused if the name is taken), then publishes the key. Each connected client must
 * run as this user; the next instance is offered before a connection is handed out.
 */
export function listenPipe<T>(path: string, handlers: PipeHandlers<T>, options: PipeListenerOptions): PipeListener {
	const w = win();
	const { user } = currentUser();
	const key = randomBytes(16).toString("hex");
	const name = pipeName(path, key);
	const fileDescriptor = new SecurityDescriptor(privateFileSddl(user, false));
	let keyFile: Handle;
	try {
		// The key file claims the endpoint like a Unix socket file; clients read it as empty until the pipe exists.
		keyFile = Number(w.CreateFileW(wide(path), GENERIC_WRITE | DELETE, FILE_SHARE_ALL, fileDescriptor.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | SQOS_IDENTIFICATION, 0));
		if (keyFile === INVALID_HANDLE) {
			if (existsSync(path)) throw new EndpointInUseError(`${path} is in use: its pipe key file already exists`);
			fail("CreateFileW", path);
		}
	} finally { fileDescriptor.release(); }
	const descriptor = new SecurityDescriptor(privatePipeSddl(user));
	let next: Handle | undefined;
	try {
		next = createInstance(name, descriptor, true);
		const written = new Uint32Array(1);
		const bytes = Buffer.from(key);
		if (!w.WriteFile(keyFile, bytes, bytes.length, written, null) || written[0] !== bytes.length) fail("WriteFile", path);
		if (!w.FlushFileBuffers(keyFile)) fail("FlushFileBuffers", path);
	} catch (error) {
		if (next !== undefined) w.CloseHandle(next);
		deleteByHandle(keyFile);
		w.CloseHandle(keyFile);
		descriptor.release();
		throw error;
	}
	w.CloseHandle(keyFile);

	const sockets = new Set<PipeSocket<T>>();
	const tracked: PipeHandlers<T> = { ...handlers, close(socket) { sockets.delete(socket); handlers.close(socket); } };
	const listen = new Operation(0);
	let listening = false;
	let stopped = false;

	/** Replaces the instance in `next`; false (and accepting ends, reported) if none can be created. */
	const renew = (): boolean => {
		try {
			next = createInstance(name, descriptor, false);
			return true;
		} catch (error) {
			next = undefined;
			options.failed(error as Error);
			return false;
		}
	};

	const connected = (): void => {
		const current = next!;
		// Offer the next instance before handing this one out, so clients never find the name missing.
		const renewed = renew();
		let peer: string;
		try { peer = clientUser(current); }
		catch (error) { peer = `an unidentified user (${(error as Error).message})`; }
		if (peer === user) {
			const socket = new PipeSocket<T>(current, tracked);
			sockets.add(socket);
			socket.start();
		} else {
			const refused = new PipeSocket<undefined>(current, { open() {}, data() {}, drain() {}, close() {} });
			refused.write(options.refusal(`pipe client runs as ${peer}, not the current user`));
			refused.end();
		}
		if (renewed) accept();
	};

	const accept = (): void => {
		while (!stopped && next !== undefined) {
			const status = w.NtFsControlFile(next, listen.event, null, null, listen.status, FSCTL_PIPE_LISTEN, null, 0, null, 0);
			if (status === STATUS_PENDING) {
				listening = true;
				listen.wait(() => {
					listening = false;
					if (stopped) { listen.release(); return; }
					const final = listen.result().status;
					if (final >= 0) { connected(); return; }
					// A client that left before the listen completed: recycle the instance.
					w.CloseHandle(next!);
					if (renew()) accept();
				});
				return;
			}
			if (status >= 0 || status === STATUS_PIPE_CONNECTED) { connected(); return; }
			w.CloseHandle(next);
			if (!renew()) return;
		}
	};
	accept();

	return {
		pipeName: name,
		stop(closeActiveConnections = false) {
			if (stopped) return;
			stopped = true;
			if (next !== undefined) {
				if (listening) w.CancelIoEx(next, null);
				w.CloseHandle(next);
				next = undefined;
			}
			if (!listening) listen.release();
			descriptor.release();
			if (closeActiveConnections) for (const socket of [...sockets]) socket.terminate();
			removeKeyFile(path, key);
		},
	};
}

/** How long a client waits for a busy listener to offer its next instance (`noli_platform`'s BUSY_WAIT). */
const BUSY_WAIT_MS = 2000;
const ERROR_PIPE_BUSY = 231;

/**
 * Connects like `noli_platform::ipc::NamedPipes::connect`: reads the key file at `path`,
 * opens the pipe it names with identification-only SQOS (retrying while every instance is
 * busy), and requires that the pipe object is owned by this user's SID before anything is
 * sent. Noli's server is the production client; this one serves tests and smoke checks.
 */
export async function connectPipe<T>(path: string, handlers: PipeHandlers<T>): Promise<PipeSocket<T>> {
	const w = win();
	const key = readFileSync(path, "utf8").trim();
	if (!isPipeKey(key)) throw new WindowsError("connect", 0, `${path} has no pipe key`);
	const name = wide(pipeName(path, key));
	const deadline = Date.now() + BUSY_WAIT_MS;
	let handle: Handle;
	for (;;) {
		handle = Number(w.CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, null, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SQOS_IDENTIFICATION, 0));
		if (handle !== INVALID_HANDLE) break;
		const error = w.GetLastError();
		if (error !== ERROR_PIPE_BUSY || Date.now() >= deadline) throw new WindowsError("CreateFileW", error, pipeName(path, key));
		await Bun.sleep(10);
	}
	let owner: string;
	try { owner = handleSecurity(handle, true).owner; }
	catch (error) { w.CloseHandle(handle); throw error; }
	if (owner !== currentUser().user) {
		w.CloseHandle(handle);
		throw new NotPrivateError("pipe_owner", `${path} is served by another user (pipe owner ${owner})`);
	}
	const socket = new PipeSocket<T>(handle, handlers);
	socket.start();
	return socket;
}
