import { readFileSync } from "node:fs";
import { pipeName } from "../src/windows-security";

/**
 * The address a test client connects to for the bridge endpoint at `path`: the Unix socket
 * itself, or on Windows the named pipe its key file names (noli_platform's contract). Pipe
 * ownership checks live in bridge.test.ts and windows-pipe.test.ts; these clients only talk.
 */
export function endpointAddress(path: string): string {
	return process.platform === "win32" ? pipeName(path, readFileSync(path, "utf8").trim()) : path;
}
