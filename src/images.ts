import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const INSTRUCTION = "Authenticated Noli image display is available through noli_show_image. To show a screenshot or another image inline, pass its local file path (relative to the working directory) or HTTP(S) URL, with an optional caption. PNG, JPEG, WebP and GIF are supported, up to 5 MiB. Image bytes are submitted as a displayed, persisted Noli message, not duplicated in the tool result.";
const MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
type ImageMime = (typeof MIME_TYPES)[number];
type Owner = { manager: ExtensionContext["sessionManager"]; sessionId: string; agentId: string };

function checkCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Image display cancelled");
}

/** Native decoding is not abortable; stop waiting without ever publishing its eventual result. */
async function cancellable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	checkCancelled(signal);
	if (!signal) return work;
	let cancel!: () => void;
	const cancelled = new Promise<never>((_resolve, reject) => {
		cancel = () => reject(new Error("Image display cancelled"));
		signal.addEventListener("abort", cancel, { once: true });
	});
	try {
		return await Promise.race([work, cancelled]);
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

function boundedSize(size: number): void {
	if (size > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 5 MiB limit");
}

async function readFile(path: string, signal: AbortSignal | undefined): Promise<Buffer> {
	checkCancelled(signal);
	// Nonblocking open prevents a named pipe from hanging before the regular-file check.
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		checkCancelled(signal);
		const metadata = await file.stat();
		if (!metadata.isFile()) throw new Error("Image source must be a regular file");
		boundedSize(metadata.size);
		const stream = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, signal });
		const chunks: Buffer[] = [];
		let size = 0;
		try {
			for await (const chunk of stream) {
				checkCancelled(signal);
				size += chunk.length;
				boundedSize(size);
				chunks.push(chunk);
			}
			return Buffer.concat(chunks, size);
		} finally {
			stream.destroy();
		}
	} finally {
		await file.close();
	}
}

async function readUrl(url: URL, signal: AbortSignal | undefined): Promise<{ bytes: Buffer; declaredMime?: string }> {
	checkCancelled(signal);
	const controller = new AbortController();
	let timedOut = false;
	const cancel = (): void => controller.abort();
	signal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, IMAGE_FETCH_TIMEOUT_MS);
	timer.unref();
	let body: ReadableStream<Uint8Array> | null | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const response = await fetch(url, { signal: controller.signal });
		body = response.body;
		if (!response.ok) throw new Error(`Image download failed (HTTP ${response.status})`);
		if (response.url && !["http:", "https:"].includes(new URL(response.url).protocol)) throw new Error("Image URL must use HTTP or HTTPS");
		const length = response.headers.get("content-length");
		if (length && /^\d+$/.test(length)) boundedSize(Number(length));
		const declaredMime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
		if (declaredMime && declaredMime !== "application/octet-stream" && !MIME_TYPES.some(mime => mime === declaredMime)) {
			throw new Error("Image response must be PNG, JPEG, WebP or GIF");
		}
		if (!body) throw new Error("Image is empty");
		reader = body.getReader();
		const chunks: Buffer[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			checkCancelled(signal);
			if (done) break;
			size += value.byteLength;
			boundedSize(size);
			chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
		}
		return { bytes: Buffer.concat(chunks, size), declaredMime };
	} catch (error) {
		checkCancelled(signal);
		if (timedOut) throw new Error("Image download timed out after 15 seconds");
		throw error;
	} finally {
		clearTimeout(timer);
		controller.abort();
		signal?.removeEventListener("abort", cancel);
		// Cancelling even a rejected oversized response releases its connection and unread bytes.
		if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
		else if (body) await body.cancel().catch(() => {});
	}
}

function imageMime(bytes: Buffer): ImageMime {
	if (bytes.length === 0) throw new Error("Image is empty");
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
	throw new Error("Image bytes must be PNG, JPEG, WebP or GIF");
}

/** Check complete containers too: metadata readers can accept a truncated image header. */
function completeContainer(bytes: Buffer, mime: ImageMime): boolean {
	switch (mime) {
		case "image/png": {
			let offset = 8;
			let pixels = false;
			while (offset + 12 <= bytes.length) {
				const length = bytes.readUInt32BE(offset);
				const type = bytes.toString("ascii", offset + 4, offset + 8);
				if (offset + 12 + length > bytes.length) return false;
				if (offset === 8 && (type !== "IHDR" || length !== 13)) return false;
				if (type === "IDAT" && length > 0) pixels = true;
				offset += 12 + length;
				if (type === "IEND") return pixels && length === 0 && offset === bytes.length;
			}
			return false;
		}
		case "image/jpeg": return bytes.length > 4 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
		case "image/gif": return bytes.length > 13 && bytes[bytes.length - 1] === 0x3b;
		case "image/webp": {
			if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
			let offset = 12;
			let pixels = false;
			while (offset + 8 <= bytes.length) {
				const type = bytes.toString("ascii", offset, offset + 4);
				const length = bytes.readUInt32LE(offset + 4);
				offset += 8 + length + (length % 2);
				if (offset > bytes.length) return false;
				if (["VP8 ", "VP8L", "ANMF"].includes(type) && length > 0) pixels = true;
			}
			return pixels && offset === bytes.length;
		}
	}
}

async function validateImage(bytes: Buffer, declaredMime: string | undefined, signal: AbortSignal | undefined): Promise<ImageMime> {
	checkCancelled(signal);
	const mime = imageMime(bytes);
	if (declaredMime && declaredMime !== "application/octet-stream" && declaredMime !== mime) throw new Error("Image MIME type does not match its bytes");
	if (!completeContainer(bytes, mime)) throw new Error("Image bytes are invalid or incomplete");
	if (typeof Bun.Image !== "function") throw new Error("Image display requires an OMP runtime with Bun.Image support (Bun 1.4.2 or newer)");
	try {
		const image = new Bun.Image(bytes);
		const metadata = await cancellable(image.metadata(), signal);
		if (`image/${metadata.format}` !== mime || metadata.width <= 0 || metadata.height <= 0) throw new Error("Invalid image metadata");
		// Full native decode, with a tiny discarded output; preserve the original file, including GIF animation.
		await cancellable(image.resize(1, 1).png().bytes(), signal);
	} catch {
		checkCancelled(signal);
		throw new Error("Image bytes are invalid or incomplete");
	}
	return mime;
}

/** Register only after the launching app supplies both bridge environment variables. */
export function installImagePublisher(pi: ExtensionAPI, authenticated: (sessionId: string) => boolean): void {
	let owner: Owner | undefined;
	const adopt = (ctx: ExtensionContext): void => {
		if (ctx.agent.kind === "main") owner = { manager: ctx.sessionManager, sessionId: ctx.sessionManager.getSessionId(), agentId: ctx.agent.id };
	};
	pi.on("session_start", (_event, ctx) => adopt(ctx));
	pi.on("session_switch", (_event, ctx) => adopt(ctx));
	pi.on("session_branch", (_event, ctx) => adopt(ctx));
	pi.on("session_tree", (_event, ctx) => adopt(ctx));
	pi.on("session_shutdown", (_event, ctx) => { if (ctx.agent.kind === "main") owner = undefined; });
	const available = (ctx: ExtensionContext): boolean => !!owner && ctx.agent.kind === "main" && ctx.agent.id === owner.agentId && ctx.sessionManager === owner.manager && ctx.sessionManager.getSessionId() === owner.sessionId && authenticated(owner.sessionId);
	pi.on("before_agent_start", (event, ctx) => {
		if (!available(ctx)) return;
		return { systemPrompt: [...event.systemPrompt.filter(line => line !== INSTRUCTION), INSTRUCTION] };
	});
	pi.registerTool({
		name: "noli_show_image",
		label: "Show image in Noli",
		description: "Display a local screenshot/image or an HTTP(S) image inline in authenticated Noli chat. Supports PNG, JPEG, WebP and GIF up to 5 MiB. The image is submitted for persisted display; the tool result contains only an acknowledgement, never image bytes.",
		approval: "read",
		parameters: pi.zod.object({
			source: pi.zod.string().min(1).describe("Local image path, absolute or relative to the working directory, or HTTP(S) URL"),
			caption: pi.zod.string().optional().describe("Optional text displayed with the image"),
		}).strict(),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			checkCancelled(signal);
			if (!available(ctx)) throw new Error("Image display is restricted to the main authenticated Noli session");
			const originalOwner = owner;
			if (typeof params.source !== "string" || !params.source.trim() || (params.caption !== undefined && typeof params.caption !== "string")) throw new Error("Invalid image source or caption");
			const scheme = /^[a-z]:[\\/]/i.test(params.source) ? undefined : /^([a-z][a-z\d+.-]*):/i.exec(params.source)?.[1]?.toLowerCase();
			let bytes: Buffer;
			let declaredMime: string | undefined;
			if (scheme) {
				if (scheme !== "http" && scheme !== "https") throw new Error("Image URL must use HTTP or HTTPS; otherwise use a local file path");
				let url: URL;
				try { url = new URL(params.source); } catch { throw new Error("Invalid HTTP(S) image URL"); }
				({ bytes, declaredMime } = await readUrl(url, signal));
			} else bytes = await readFile(resolve(ctx.cwd, params.source), signal);
			const mimeType = await validateImage(bytes, declaredMime, signal);
			checkCancelled(signal);
			if (owner !== originalOwner || !available(ctx)) throw new Error("Image display lost its authenticated session during the image read");
			const data = bytes.toString("base64");
			pi.sendMessage({
				customType: "noli.image",
				display: true,
				content: [...(params.caption ? [{ type: "text" as const, text: params.caption }] : []), { type: "image", data, mimeType }],
			}, ctx.isIdle() ? { triggerTurn: false } : { triggerTurn: false, deliverAs: "aside" });
			// sendMessage is void: admission is acknowledged, not an unobservable persistence completion.
			return { content: [{ type: "text", text: "Image submitted to Noli for display." }], details: { status: "submitted" } };
		},
	});
}
