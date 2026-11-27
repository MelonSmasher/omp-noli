/**
 * Platform-neutral half of the Windows port: pipe naming and the owner-only decision over
 * security descriptors. Everything here is pure, so `bun test` checks it on every OS; the
 * Win32 calls that produce its inputs live in ./windows-native.
 *
 * Both rules copy Noli's `noli_platform` exactly, so the bridge accepts what the server creates:
 * - `ipc::Endpoint::pipe_name`: `\\.\pipe\noli-<sha256(path)>-<key>`.
 * - `fs::is_private` / `windows::Grants::owner_only`: no NULL DACL, no allow ACE this check
 *   can't attribute to a SID, and every allow ACE that applies to the object itself names the
 *   current user, SYSTEM or Administrators (who can take any object anyway, like root on Unix).
 * - `fs::is_owned_by_current_user`: the owner is the user's SID or the token's default owner
 *   (an elevated administrator creates objects owned by Administrators).
 */
import { createHash } from "node:crypto";

export const SYSTEM_SID = "S-1-5-18";
export const ADMINISTRATORS_SID = "S-1-5-32-544";

/** A listener's pipe key: 32 lowercase hex digits, as `noli_platform::ipc` writes and accepts. */
export function isPipeKey(key: string): boolean {
	return /^[0-9a-f]{32}$/.test(key);
}

/**
 * The pipe for the endpoint named by `path` and its listener's `key`: the lowercase hex
 * SHA-256 of the path's UTF-8 bytes exactly as given (no normalisation), then the key.
 */
export function pipeName(path: string, key: string): string {
	if (!isPipeKey(key)) throw new TypeError("a pipe key is 32 lowercase hex digits");
	return `\\\\.\\pipe\\noli-${createHash("sha256").update(path, "utf8").digest("hex")}-${key}`;
}

/**
 * Rust's `Path::join` on Windows, which Noli uses to name the endpoint: one `\` unless `dir`
 * already ends with a separator. `node:path` would also normalise `/` and `..`, and the pipe
 * name hashes the exact string, so a normalised spelling would name a different pipe.
 */
export function windowsJoin(dir: string, name: string): string {
	return /[\\/]$/.test(dir) ? `${dir}${name}` : `${dir}\\${name}`;
}

/** Who a DACL lets in, apart from denials (`noli_platform::windows::Grants`). */
export interface Grants {
	/** No DACL at all: everyone has full access. */
	nullDacl: boolean;
	/** SIDs with an allow ACE that applies to the object itself. */
	allowed: string[];
	/** An allow ACE this check can't attribute to a SID (object, callback or malformed): someone else. */
	opaque: boolean;
}

const ACCESS_ALLOWED_ACE_TYPE = 0x0;
const ACCESS_ALLOWED_OBJECT_ACE_TYPE = 0x5;
const ACCESS_ALLOWED_CALLBACK_ACE_TYPE = 0x9;
const ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE = 0xb;
const INHERIT_ONLY_ACE = 0x08;
const ACL_HEADER_BYTES = 8;
const ACE_HEADER_BYTES = 4;
/** An ACCESS_ALLOWED_ACE: header, access mask, then the SID. */
const ALLOWED_SID_OFFSET = 8;

/** A binary SID at `offset` in SDDL form, as `ConvertSidToStringSidW` writes it. Undefined if truncated. */
export function sidString(bytes: Uint8Array, offset = 0, end = bytes.length): string | undefined {
	if (offset + 8 > end) return undefined;
	const revision = bytes[offset]!;
	const count = bytes[offset + 1]!;
	if (offset + 8 + 4 * count > end) return undefined;
	const authority = bytes.subarray(offset + 2, offset + 8);
	const high = (authority[0]! << 8) | authority[1]!;
	const low = ((authority[2]! << 24) >>> 0) + (authority[3]! << 16) + (authority[4]! << 8) + authority[5]!;
	const identifier = high === 0
		? String(low)
		: `0x${[...authority].map(byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const parts = [`S-${revision}-${identifier}`];
	for (let index = 0; index < count; index++) parts.push(String(view.getUint32(offset + 8 + 4 * index, true)));
	return parts.join("-");
}

/** Bytes a binary SID at `offset` occupies. */
export function sidLength(bytes: Uint8Array, offset = 0): number {
	return 8 + 4 * (bytes[offset + 1] ?? 0);
}

/**
 * The grants of a binary ACL, or of no DACL (`null`). Inherit-only ACEs don't apply to the
 * object and are skipped. Anything malformed counts as a grant to someone else (fail closed).
 */
export function parseDacl(acl: Uint8Array | null): Grants {
	if (acl === null) return { nullDacl: true, allowed: [], opaque: false };
	const allowed: string[] = [];
	if (acl.length < ACL_HEADER_BYTES) return { nullDacl: false, allowed, opaque: true };
	const view = new DataView(acl.buffer, acl.byteOffset, acl.byteLength);
	const size = Math.min(view.getUint16(2, true), acl.length);
	const count = view.getUint16(4, true);
	let opaque = false;
	let offset = ACL_HEADER_BYTES;
	for (let index = 0; index < count; index++) {
		if (offset + ACE_HEADER_BYTES > size) return { nullDacl: false, allowed, opaque: true };
		const type = acl[offset]!;
		const flags = acl[offset + 1]!;
		const aceSize = view.getUint16(offset + 2, true);
		if (aceSize < ACE_HEADER_BYTES || offset + aceSize > size) return { nullDacl: false, allowed, opaque: true };
		if ((flags & INHERIT_ONLY_ACE) === 0) {
			if (type === ACCESS_ALLOWED_ACE_TYPE) {
				const sid = sidString(acl, offset + ALLOWED_SID_OFFSET, offset + aceSize);
				if (sid === undefined) opaque = true;
				else allowed.push(sid);
			} else if (type === ACCESS_ALLOWED_OBJECT_ACE_TYPE || type === ACCESS_ALLOWED_CALLBACK_ACE_TYPE || type === ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE) {
				opaque = true;
			}
		}
		offset += aceSize;
	}
	return { nullDacl: false, allowed, opaque };
}

/** Why an object's security fails the owner-only rule, or undefined if it passes. */
export type PrivacyFault =
	| { kind: "owner"; owner: string }
	| { kind: "null_dacl" }
	| { kind: "opaque_grant" }
	| { kind: "shared"; trustees: string[] };

export interface ObjectSecurity {
	owner: string;
	/** The binary DACL, or null when the object has none. */
	dacl: Uint8Array | null;
}

export interface CurrentUser {
	/** The token user's SID. */
	user: string;
	/** The token's default owner: the user, or Administrators when elevated. */
	defaultOwner: string;
}

/** `is_owned_by_current_user` and `is_private` together, as Noli applies them to its private files. */
export function privacyFault(security: ObjectSecurity, current: CurrentUser): PrivacyFault | undefined {
	if (security.owner !== current.user && security.owner !== current.defaultOwner) return { kind: "owner", owner: security.owner };
	const grants = parseDacl(security.dacl);
	if (grants.nullDacl) return { kind: "null_dacl" };
	if (grants.opaque) return { kind: "opaque_grant" };
	const others = grants.allowed.filter(sid => sid !== current.user && sid !== SYSTEM_SID && sid !== ADMINISTRATORS_SID);
	if (others.length) return { kind: "shared", trustees: [...new Set(others)] };
	return undefined;
}

export function describeFault(fault: PrivacyFault): string {
	switch (fault.kind) {
		case "owner": return `is owned by ${fault.owner}, not the current user`;
		case "null_dacl": return "has no DACL, so everyone has access";
		case "opaque_grant": return "has an access grant that cannot be attributed to a user";
		case "shared": return `must not be accessible to other users (DACL grants ${fault.trustees.join(", ")})`;
	}
}

/** SDDL for a file or directory only the user can open; `inherit` passes the grant to new children. */
export function privateFileSddl(user: string, inherit: boolean): string {
	return `D:P(A;${inherit ? "OICI" : ""};FA;;;${user})`;
}

/** SDDL for the pipe: owned by the user's SID explicitly (clients require that owner), granting only the user. */
export function privatePipeSddl(user: string): string {
	return `O:${user}D:P(A;;GA;;;${user})`;
}
