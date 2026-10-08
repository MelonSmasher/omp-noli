import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import * as zod from "@oh-my-pi/omptype/zod";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import noli, { ENV_DIR, ENV_TOKEN_FILE } from "../src/index";
import { IMAGE_FETCH_TIMEOUT_MS, MAX_IMAGE_BYTES, installImagePublisher } from "../src/images";

type ImageTool = ToolDefinition<zod.ZodLikeSchema<{ source: string; caption?: string }>, { status: string }>;
type ImageMessage = { customType: string; display: boolean; content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] };
type SendOptions = { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" };
type HandlerResult = { systemPrompt: string[] } | undefined;
type Handler = (event: { systemPrompt?: string[] }, ctx: ExtensionContext) => HandlerResult;

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function png(): Buffer {
	const chunk = (type: string, data: Buffer): Buffer => {
		const result = Buffer.alloc(12 + data.length);
		result.writeUInt32BE(data.length);
		result.write(type, 4);
		data.copy(result, 8);
		let crc = 0xffffffff;
		for (const byte of result.subarray(4, -4)) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
		}
		result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
		return result;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(2, 0);
	header.writeUInt32BE(1, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255]))), chunk("IEND", Buffer.alloc(0)),
	]);
}

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "noli-images-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ImageTool>();
	const published: { message: ImageMessage; options?: SendOptions }[] = [];
	let sessionId = "owning-session";
	let authenticated = true;
	let idle = false;
	const ctx = {
		cwd, agent: { kind: "main", id: "Main" },
		sessionManager: { getSessionId: () => sessionId }, isIdle: () => idle,
	} as unknown as ExtensionContext;
	const pi = {
		zod,
		on: (name: string, handler: Handler) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool: (tool: ImageTool) => tools.set(tool.name, tool),
		sendMessage: (message: ImageMessage, options?: SendOptions) => published.push({ message, options }),
	} as unknown as ExtensionAPI;
	const emit = (name: string, context = ctx, event: { systemPrompt?: string[] } = {}): HandlerResult[] => (handlers.get(name) ?? []).map(handler => handler(event, context));
	installImagePublisher(pi, id => authenticated && id === sessionId);
	emit("session_start");
	const tool = tools.get("noli_show_image")!;
	const show = (source: string, options: { caption?: string; signal?: AbortSignal; context?: ExtensionContext } = {}) =>
		tool.execute("image-call", { source, caption: options.caption }, options.signal, undefined, options.context ?? ctx);
	return {
		cwd, ctx, pi, emit, tool, show, published,
		setAuthenticated: (value: boolean) => { authenticated = value; },
		setSessionId: (value: string) => { sessionId = value; },
		setIdle: (value: boolean) => { idle = value; },
	};
}

function server(handler: (request: Request) => Response | Promise<Response>): string {
	const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handler });
	cleanups.push(() => { listener.stop(true); });
	return `http://127.0.0.1:${listener.port}/image`;
}

function streamResponse(bytes: Buffer, beforeClose?: () => void): Response {
	return new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(bytes.subarray(0, 7));
			controller.enqueue(bytes.subarray(7));
			beforeClose?.();
			controller.close();
		},
	}), { headers: { "content-type": "image/png" } });
}

test("registered tool uses injected SDK schema and validates its public input", () => {
	const f = fixture();
	expect(f.tool.parameters).toBeDefined();
	expect(f.tool.parameters.parse({ source: "image.png", caption: "Screenshot" })).toEqual({ source: "image.png", caption: "Screenshot" });
	for (const input of [{}, { source: "" }, { source: "image.png", caption: 3 }, { source: "image.png", data: "bulk" }]) {
		expect(() => f.tool.parameters.parse(input)).toThrow();
	}
});

test("relative local image publishes caption and exact bytes once, not in tool output", async () => {
	const f = fixture();
	const bytes = png();
	writeFileSync(join(f.cwd, "screen.capture"), bytes);
	const result = await f.show("screen.capture", { caption: "Current screen" });
	expect(f.published).toEqual([{
		message: { customType: "noli.image", display: true, content: [{ type: "text", text: "Current screen" }, { type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] },
		options: { triggerTurn: false, deliverAs: "aside" },
	}]);
	expect(result).toEqual({ content: [{ type: "text", text: "Image submitted to Noli for display." }], details: { status: "submitted" } });
	expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
	f.setIdle(true);
	await f.show(join(f.cwd, "screen.capture"));
	expect(f.published[1]!.options).toEqual({ triggerTurn: false });
	expect(f.published[1]!.message.content).toHaveLength(1);
});

test("JPEG, WebP and GIF local images keep their original format and bytes", async () => {
	const f = fixture();
	const formats = [
		["jpeg", Buffer.from(await new Bun.Image(png()).jpeg().bytes())],
		["webp", Buffer.from(await new Bun.Image(png()).webp().bytes())],
		["gif", Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")],
	] as const;
	for (const [format, bytes] of formats) {
		writeFileSync(join(f.cwd, `image.${format}`), bytes);
		await f.show(`image.${format}`);
		expect(f.published.at(-1)!.message.content).toEqual([{ type: "image", data: bytes.toString("base64"), mimeType: `image/${format}` }]);
	}
});

test("HTTP streaming image and redirect publish bytes with canonical MIME", async () => {
	const f = fixture();
	const bytes = png();
	const url = server(request => new URL(request.url).pathname === "/image" ? new Response(null, { status: 302, headers: { location: "/final" } }) : streamResponse(bytes));
	await f.show(url);
	expect(f.published[0]!.message.content).toEqual([{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }]);
});

test("missing or octet-stream HTTP MIME is inferred from validated image bytes", async () => {
	const f = fixture();
	for (const headers of [new Headers(), new Headers({ "content-type": "application/octet-stream" })]) {
		await f.show(server(() => new Response(new Uint8Array(png()), { headers })));
		expect(f.published.at(-1)!.message.content).toEqual([{ type: "image", data: png().toString("base64"), mimeType: "image/png" }]);
	}
});

test("local failure paths never publish", async () => {
	const f = fixture();
	writeFileSync(join(f.cwd, "empty"), "");
	writeFileSync(join(f.cwd, "text.png"), "not an image");
	writeFileSync(join(f.cwd, "header.png"), png().subarray(0, 33));
	writeFileSync(join(f.cwd, "oversized"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
	mkdirSync(join(f.cwd, "directory"));
	for (const source of ["missing.png", "empty", "text.png", "header.png", "oversized", "directory", "data:image/png;base64,AAAA", "file:///tmp/image.png", "ftp://example.invalid/image", "http://", " "]) {
		await expect(f.show(source)).rejects.toThrow();
	}
	expect(f.published).toHaveLength(0);
});

test("all supported truncated containers and corrupted pixels fail native validation", async () => {
	const f = fixture();
	const original = png();
	const corrupt = Buffer.from(original);
	corrupt.fill(0, 41, corrupt.length - 12);
	const fixtures = [
		original.subarray(0, -1), corrupt,
		Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
		Buffer.from("GIF89a"), Buffer.from("RIFF\x04\0\0\0WEBP", "binary"),
	];
	for (let index = 0; index < fixtures.length; index++) {
		writeFileSync(join(f.cwd, `bad-${index}`), fixtures[index]!);
		await expect(f.show(`bad-${index}`)).rejects.toThrow("invalid or incomplete");
	}
	expect(f.published).toHaveLength(0);
});

test("HTTP error status fails without publication", async () => {
	const f = fixture();
	await expect(f.show(server(() => new Response("missing", { status: 404 })))).rejects.toThrow("HTTP 404");
	expect(f.published).toHaveLength(0);
});

test("HTTP non-image MIME fails without publication", async () => {
	const f = fixture();
	await expect(f.show(server(() => new Response("<html>not an image</html>", { headers: { "content-type": "text/html" } })))).rejects.toThrow("must be PNG");
	expect(f.published).toHaveLength(0);
});

test("HTTP declared MIME mismatch fails without publication", async () => {
	const f = fixture();
	await expect(f.show(server(() => new Response(new Uint8Array(png()), { headers: { "content-type": "image/jpeg" } })))).rejects.toThrow("does not match");
	expect(f.published).toHaveLength(0);
});

test("HTTP empty image fails without publication", async () => {
	const f = fixture();
	await expect(f.show(server(() => new Response(null, { headers: { "content-type": "image/png" } })))).rejects.toThrow("empty");
	expect(f.published).toHaveLength(0);
});

test("HTTP known oversized body fails without publication", async () => {
	const f = fixture();
	// Let Bun emit its accurate Content-Length rather than a header inconsistent with the body.
	await expect(f.show(server(() => new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), { headers: { "content-type": "image/png" } })))).rejects.toThrow("5 MiB");
	expect(f.published).toHaveLength(0);
});

test("HTTP chunked oversized body fails without publication", async () => {
	const f = fixture();
	await expect(f.show(server(() => streamResponse(Buffer.alloc(MAX_IMAGE_BYTES + 1))))).rejects.toThrow("5 MiB");
	expect(f.published).toHaveLength(0);
});

test("main authenticated ownership is required before reading and before publishing", async () => {
	const f = fixture();
	writeFileSync(join(f.cwd, "screen.png"), png());
	f.setAuthenticated(false);
	await expect(f.show("screen.png")).rejects.toThrow("main authenticated");
	f.setAuthenticated(true);
	await expect(f.show("screen.png", { context: { ...f.ctx, agent: { ...f.ctx.agent, kind: "sub" } } })).rejects.toThrow("main authenticated");
	await expect(f.show("screen.png", { context: { ...f.ctx, sessionManager: { getSessionId: () => "owning-session" } as ExtensionContext["sessionManager"] } })).rejects.toThrow("main authenticated");
	await expect(f.show(server(() => streamResponse(png(), () => f.setAuthenticated(false))))).rejects.toThrow("lost its authenticated session");
	expect(f.published).toHaveLength(0);
});

test("session switch, same-id readoption, shutdown and changed session discard delayed reads", async () => {
	for (const change of ["session_switch", "session_branch", "session_tree", "session_shutdown", "identity"]) {
		const f = fixture();
		const url = server(() => streamResponse(png(), () => {
			if (change === "identity") f.setSessionId("replacement-session");
			else f.emit(change);
		}));
		const pending = f.show(url);
		await expect(pending).rejects.toThrow("lost its authenticated session");
		expect(f.published).toHaveLength(0);
	}
}, 30_000);

test("pre-aborted and in-flight network cancellation never publish", async () => {
	const f = fixture();
	const aborted = AbortSignal.abort();
	await expect(f.show("missing", { signal: aborted })).rejects.toThrow("cancelled");
	const controller = new AbortController();
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const url = server(async () => { started.resolve(); await gate.promise; return streamResponse(png()); });
	const pending = f.show(url, { signal: controller.signal });
	await started.promise;
	controller.abort();
	gate.resolve();
	await expect(pending).rejects.toThrow("cancelled");
	expect(f.published).toHaveLength(0);
});

test("cancellation after streamed bytes arrive still prevents publication", async () => {
	const f = fixture();
	const controller = new AbortController();
	await expect(f.show(server(() => streamResponse(png(), () => controller.abort())), { signal: controller.signal })).rejects.toThrow("cancelled");
	expect(f.published).toHaveLength(0);
});

test("local cancellation after opening starts prevents publication", async () => {
	const f = fixture();
	writeFileSync(join(f.cwd, "screen.png"), png());
	const controller = new AbortController();
	const pending = f.show("screen.png", { signal: controller.signal });
	controller.abort();
	await expect(pending).rejects.toThrow("cancelled");
	expect(f.published).toHaveLength(0);
});

test("cancellation during native decoding does not publish its eventual result", async () => {
	const f = fixture();
	writeFileSync(join(f.cwd, "screen.png"), png());
	const descriptor = Object.getOwnPropertyDescriptor(Bun, "Image")!;
	const entered = Promise.withResolvers<void>();
	const decoded = Promise.withResolvers<{ width: number; height: number; format: "png" }>();
	// A controlled native boundary exposes the cancellation race without changing tool/schema behavior.
	class DelayedImage {
		metadata() { entered.resolve(); return decoded.promise; }
	}
	Object.defineProperty(Bun, "Image", { ...descriptor, value: DelayedImage });
	try {
		const controller = new AbortController();
		const pending = f.show("screen.png", { signal: controller.signal });
		await entered.promise;
		controller.abort();
		decoded.resolve({ width: 2, height: 1, format: "png" });
		await expect(pending).rejects.toThrow("cancelled");
		expect(f.published).toHaveLength(0);
	} finally { Object.defineProperty(Bun, "Image", descriptor); }
});

test("a runtime without native decoding fails explicitly, never with fake success", async () => {
	const f = fixture();
	writeFileSync(join(f.cwd, "screen.png"), png());
	const descriptor = Object.getOwnPropertyDescriptor(Bun, "Image")!;
	Object.defineProperty(Bun, "Image", { ...descriptor, value: undefined });
	try {
		await expect(f.show("screen.png")).rejects.toThrow("Bun.Image support");
		expect(f.published).toHaveLength(0);
	} finally { Object.defineProperty(Bun, "Image", descriptor); }
});

test("network timeout bounds an unfinished body and never publishes", async () => {
	const f = fixture();
	const url = server(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(png().subarray(0, 8)); } }), { headers: { "content-type": "image/png" } }));
	await expect(f.show(url)).rejects.toThrow("timed out");
	expect(f.published).toHaveLength(0);
}, IMAGE_FETCH_TIMEOUT_MS + 5_000);

test("authenticated main request discovers the tool without persisted instruction messages", () => {
	const f = fixture();
	const instruction = f.emit("before_agent_start", f.ctx, { systemPrompt: ["base"] })[0]!.systemPrompt;
	expect(instruction[1]).toContain("noli_show_image");
	expect(f.emit("before_agent_start", f.ctx, { systemPrompt: instruction })[0]!.systemPrompt).toEqual(instruction);
	f.setAuthenticated(false);
	expect(f.emit("before_agent_start", f.ctx, { systemPrompt: ["base"] })[0]).toBeUndefined();
	expect(f.published).toHaveLength(0);
});

test("entrypoint registers no image tool unless both bridge launch variables exist", () => {
	const f = fixture();
	const originalDir = process.env[ENV_DIR];
	const originalTokenFile = process.env[ENV_TOKEN_FILE];
	const dir = mkdtempSync(join(tmpdir(), "noli-image-bootstrap-"));
	const tokenFile = join(dir, "bootstrap-token");
	const names: string[] = [];
	const pi = { ...f.pi, registerTool: (tool: ToolDefinition) => names.push(tool.name), pi: {}, events: { on: () => {} } } as unknown as ExtensionAPI;
	try {
		for (const [bridgeDir, file] of [[undefined, undefined], [dir, undefined], [undefined, tokenFile]]) {
			if (bridgeDir) process.env[ENV_DIR] = bridgeDir; else delete process.env[ENV_DIR];
			if (file) process.env[ENV_TOKEN_FILE] = file; else delete process.env[ENV_TOKEN_FILE];
			noli(pi);
		}
		expect(names).toHaveLength(0);
		process.env[ENV_DIR] = dir;
		writeFileSync(tokenFile, "test-token", { mode: 0o600 });
		process.env[ENV_TOKEN_FILE] = tokenFile;
		noli(pi);
		expect(names).toEqual(["noli_show_image"]);
	} finally {
		if (originalDir === undefined) delete process.env[ENV_DIR]; else process.env[ENV_DIR] = originalDir;
		if (originalTokenFile === undefined) delete process.env[ENV_TOKEN_FILE]; else process.env[ENV_TOKEN_FILE] = originalTokenFile;
		rmSync(dir, { recursive: true, force: true });
	}
});
