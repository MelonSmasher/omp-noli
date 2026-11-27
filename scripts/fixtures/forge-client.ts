import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { type } from "@oh-my-pi/omptype";
import type { ServerFrame } from "../../src/protocol";

const Response = type({ type: "'response'", id: "number", ok: "true", result: "unknown" });

/** Socket fixture for successful authenticated bootstrap/adoption, never product transport. */
export class ForgeClient {
	#socket?: Socket;
	#sequence = 0;
	#pending = new Map<number, { resolve(frame: ServerFrame): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	constructor(private path: string, private token: string, private sessionId: () => string) {}
	async connect(): Promise<ServerFrame> {
		let buffered = "";
		const socket = connect(this.path);
		this.#socket = socket;
		socket.on("data", data => {
			buffered += data.toString();
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline === -1) break;
				const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
				try {
					const value = JSON.parse(line);
					if (value.type !== "response") continue;
					const response = Response.assert(value);
					const pending = this.#pending.get(response.id);
					assert(pending, "Response matches a requested smoke operation");
					this.#pending.delete(response.id); clearTimeout(pending.timer); pending.resolve(response);
				} catch (error) { this.#fail(error instanceof Error ? error : new Error(String(error))); }
			}
		});
		socket.on("error", error => this.#fail(error));
		socket.on("close", () => this.#fail(new Error("Disposable bridge client disconnected")));
		await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
		return this.request("hello", { token: this.token });
	}
	request(method: string, params: Record<string, unknown> = {}): Promise<ServerFrame> {
		const socket = this.#socket;
		assert(socket && !socket.destroyed, "Disposable authenticated bridge socket is connected");
		const id = ++this.#sequence;
		return new Promise<ServerFrame>((resolve, reject) => {
			const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Bridge smoke ${method} timed out`)); }, 5000);
			this.#pending.set(id, { resolve, reject, timer });
			socket.write(`${JSON.stringify({ id, method, params, sessionId: this.sessionId() })}\n`);
		});
	}
	async disconnect(): Promise<void> {
		const socket = this.#socket;
		this.#socket = undefined;
		if (!socket || socket.destroyed) return;
		await new Promise<void>(resolve => { socket.once("close", resolve); socket.destroy(); });
	}
	async reconnect(): Promise<void> { await this.disconnect(); await this.connect(); }
	#fail(error: Error): void {
		for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.#pending.clear();
	}
}
