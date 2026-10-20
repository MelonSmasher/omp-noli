import { describe, expect, test } from "bun:test";
import {
	ADMINISTRATORS_SID,
	type CurrentUser,
	describeFault,
	isPipeKey,
	parseDacl,
	pipeName,
	privacyFault,
	privateFileSddl,
	privatePipeSddl,
	sidString,
	SYSTEM_SID,
	windowsJoin,
} from "../src/windows-security";

const USER = "S-1-5-21-1004336348-1177238915-682003330-1001";
const ME: CurrentUser = { user: USER, defaultOwner: USER };
const ELEVATED: CurrentUser = { user: USER, defaultOwner: ADMINISTRATORS_SID };
const KEY = "0123456789abcdef0123456789abcdef";

/**
 * Binary DACLs that Windows itself encoded (.NET RawSecurityDescriptor.DiscretionaryAcl.GetBinaryForm
 * on Windows 10 22H2) from the SDDL beside each, so the parser is checked against the real format.
 */
const DACL: Record<string, { sddl: string; hex: string }> = {
	privateFile: { sddl: `D:P(A;;FA;;;${USER})`, hex: "02002c000100000000002400ff011f00010500000000000515000000dcf4dc3b833d2b46828ba628e9030000" },
	privateDir: { sddl: `D:P(A;OICI;FA;;;${USER})`, hex: "02002c000100000000032400ff011f00010500000000000515000000dcf4dc3b833d2b46828ba628e9030000" },
	systemAdmins: { sddl: `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`, hex: "020058000300000000031400ff011f0001010000000000051200000000031800ff011f000102000000000005200000002002000000032400ff011f00010500000000000515000000dcf4dc3b833d2b46828ba628e9030000" },
	everyoneRead: { sddl: `D:P(A;;FA;;;${USER})(A;;FR;;;WD)`, hex: "020040000200000000002400ff011f00010500000000000515000000dcf4dc3b833d2b46828ba628e90300000000140089001200010100000000000100000000" },
	inheritOnlyOthers: { sddl: `D:P(A;;FA;;;${USER})(A;OICIIO;GA;;;CO)(A;OICIIO;GR;;;S-1-5-32-545)`, hex: "020058000300000000002400ff011f00010500000000000515000000dcf4dc3b833d2b46828ba628e9030000000b140000000010010100000000000300000000000b18000000008001020000000000052000000021020000" },
	denyEveryone: { sddl: `D:P(D;;FA;;;WD)(A;;FA;;;${USER})`, hex: "020040000200000001001400ff011f0001010000000000010000000000002400ff011f00010500000000000515000000dcf4dc3b833d2b46828ba628e9030000" },
	objectAce: { sddl: `D:P(A;;FA;;;${USER})(OA;;CR;ab721a53-1e2f-11d0-9819-00aa0040529b;;WD)`, hex: "040054000200000000002400ff011f00010500000000000515000000dcf4dc3b833d2b46828ba628e9030000050028000001000001000000531a72ab2f1ed011981900aa0040529b010100000000000100000000" },
	callbackAce: { sddl: `D:P(A;;FA;;;${USER})(XA;;FA;;;WD;(WIN://SYSAPPID Contains "x"))`, hex: "020070000200000000002400ff011f00010500000000000515000000dcf4dc3b833d2b46828ba628e903000009004400ff011f0001010000000000010000000061727478f81c000000570049004e003a002f002f00530059005300410050005000490044001002000000780086000000" },
	hexAuthority: { sddl: "D:P(A;;FA;;;S-1-281474976710655-7)", hex: "02001c000100000000001400ff011f000101ffffffffffff07000000" },
	empty: { sddl: "D:P", hex: "0200080000000000" },
};
const acl = (name: string): Uint8Array => Buffer.from(DACL[name]!.hex, "hex");

describe("pipe naming matches noli_platform::ipc", () => {
	// The contract vectors from noli_platform's `pipe_names_are_stable_distinct_and_bounded`.
	test("contract vectors", () => {
		expect(pipeName("/run/noli/mesh.sock", KEY)).toBe(String.raw`\\.\pipe\noli-c6a80d7a67c301c35f98375c0e769d2175b9ac1ddc0f502550b01f59673277dc-0123456789abcdef0123456789abcdef`);
		expect(pipeName(String.raw`C:\Users\noli\AppData\Local\Noli\server\mesh.sock`, KEY)).toBe(String.raw`\\.\pipe\noli-aa491d7e7cb33185c7ba27c4cf846df3fb832b441e526ad9d052d223b3483248-0123456789abcdef0123456789abcdef`);
	});
	test("stable, distinct per path and key, and bounded", () => {
		expect(pipeName("/run/noli/mesh.sock", KEY)).toBe(pipeName("/run/noli/mesh.sock", KEY));
		expect(pipeName("/run/noli/mesh.sock", KEY)).not.toBe(pipeName("/run/noli/server.sock", KEY));
		expect(pipeName("/run/noli/mesh.sock", KEY)).not.toBe(pipeName("/run/noli/mesh.sock", "fedcba9876543210fedcba9876543210"));
		expect(pipeName("x".repeat(4096), KEY).length).toBe(String.raw`\\.\pipe\noli-`.length + 64 + 1 + 32);
	});
	test("hashes the exact spelling: no normalisation", () => {
		expect(pipeName(String.raw`C:\Temp\noli-a\omp-1.sock`, KEY)).not.toBe(pipeName("C:/Temp/noli-a/omp-1.sock", KEY));
		expect(pipeName(String.raw`C:\Temp\noli-a\omp-1.sock`, KEY)).not.toBe(pipeName(String.raw`c:\temp\noli-a\omp-1.sock`, KEY));
	});
	test("keys are exactly 32 lowercase hex digits", () => {
		expect(isPipeKey(KEY)).toBe(true);
		for (const bad of ["", KEY.toUpperCase(), `${KEY}0`, KEY.slice(1), `${KEY.slice(1)}g`, ` ${KEY.slice(1)}`]) {
			expect(isPipeKey(bad)).toBe(false);
			expect(() => pipeName("/x", bad)).toThrow(TypeError);
		}
	});
	test("endpoint paths join like Rust's Path::join on Windows", () => {
		expect(windowsJoin(String.raw`C:\Users\a\AppData\Local\Temp\noli-x`, "omp-7.sock")).toBe(String.raw`C:\Users\a\AppData\Local\Temp\noli-x\omp-7.sock`);
		expect(windowsJoin(String.raw`C:\Temp\noli-x\\`, "omp-7.sock")).toBe(String.raw`C:\Temp\noli-x\\omp-7.sock`);
		expect(windowsJoin("C:/Temp/noli-x/", "omp-7.sock")).toBe("C:/Temp/noli-x/omp-7.sock");
		expect(windowsJoin("C:/Temp/noli-x", "omp-7.sock")).toBe(String.raw`C:/Temp/noli-x\omp-7.sock`);
	});
});

describe("SIDs and DACLs in Windows' binary form", () => {
	test("SIDs render as ConvertSidToStringSidW does", () => {
		expect(sidString(Buffer.from("010500000000000515000000dcf4dc3b833d2b46828ba628e9030000", "hex"))).toBe(USER);
		expect(sidString(Buffer.from("010100000000000512000000", "hex"))).toBe(SYSTEM_SID);
		expect(sidString(Buffer.from("01020000000000052000000020020000", "hex"))).toBe(ADMINISTRATORS_SID);
		expect(sidString(Buffer.from("010100000000000100000000", "hex"))).toBe("S-1-1-0");
		expect(parseDacl(acl("hexAuthority")).allowed).toEqual(["S-1-0xFFFFFFFFFFFF-7"]);
		expect(sidString(Buffer.from("0105000000000005150000", "hex"))).toBeUndefined();
	});
	test("allow ACEs that apply to the object are collected; inherit-only and deny ACEs are not grants", () => {
		expect(parseDacl(acl("privateFile"))).toEqual({ nullDacl: false, allowed: [USER], opaque: false });
		expect(parseDacl(acl("privateDir"))).toEqual({ nullDacl: false, allowed: [USER], opaque: false });
		expect(parseDacl(acl("systemAdmins")).allowed).toEqual([SYSTEM_SID, ADMINISTRATORS_SID, USER]);
		expect(parseDacl(acl("everyoneRead")).allowed).toEqual([USER, "S-1-1-0"]);
		expect(parseDacl(acl("inheritOnlyOthers")).allowed).toEqual([USER]);
		expect(parseDacl(acl("denyEveryone")).allowed).toEqual([USER]);
		expect(parseDacl(acl("empty"))).toEqual({ nullDacl: false, allowed: [], opaque: false });
		expect(parseDacl(null)).toEqual({ nullDacl: true, allowed: [], opaque: false });
	});
	test("object and callback allow ACEs can't be attributed: opaque", () => {
		expect(parseDacl(acl("objectAce")).opaque).toBe(true);
		expect(parseDacl(acl("callbackAce")).opaque).toBe(true);
	});
	test("malformed ACLs fail closed", () => {
		const truncated = acl("privateFile").subarray(0, 20);
		expect(parseDacl(truncated).opaque).toBe(true);
		const lying = Buffer.from(acl("privateFile"));
		lying.writeUInt16LE(5, 4); // AceCount beyond AclSize
		expect(parseDacl(lying).opaque).toBe(true);
		const tinyAce = Buffer.from(acl("privateFile"));
		tinyAce.writeUInt16LE(2, 10); // AceSize below its header
		expect(parseDacl(tinyAce).opaque).toBe(true);
		const shortSid = Buffer.from(acl("privateFile"));
		shortSid[17] = 9; // SubAuthorityCount past the ACE
		expect(parseDacl(shortSid).opaque).toBe(true);
		expect(parseDacl(new Uint8Array(4)).opaque).toBe(true);
	});
});

describe("the owner-only decision matches noli_platform::fs", () => {
	test("what Noli creates passes: private files and directories, owned by the user", () => {
		expect(privacyFault({ owner: USER, dacl: acl("privateFile") }, ME)).toBeUndefined();
		expect(privacyFault({ owner: USER, dacl: acl("privateDir") }, ME)).toBeUndefined();
	});
	test("SYSTEM and Administrators may be granted, as `is_private` allows", () => {
		expect(privacyFault({ owner: USER, dacl: acl("systemAdmins") }, ME)).toBeUndefined();
	});
	test("an elevated process's default owner (Administrators) counts as the user, other owners don't", () => {
		expect(privacyFault({ owner: ADMINISTRATORS_SID, dacl: acl("privateFile") }, ELEVATED)).toBeUndefined();
		expect(privacyFault({ owner: ADMINISTRATORS_SID, dacl: acl("privateFile") }, ME)).toEqual({ kind: "owner", owner: ADMINISTRATORS_SID });
		expect(privacyFault({ owner: "S-1-5-21-1-2-3-1002", dacl: acl("privateFile") }, ME)).toEqual({ kind: "owner", owner: "S-1-5-21-1-2-3-1002" });
	});
	test("grants to anyone else, no DACL and unattributable grants are refused", () => {
		expect(privacyFault({ owner: USER, dacl: acl("everyoneRead") }, ME)).toEqual({ kind: "shared", trustees: ["S-1-1-0"] });
		expect(privacyFault({ owner: USER, dacl: null }, ME)).toEqual({ kind: "null_dacl" });
		expect(privacyFault({ owner: USER, dacl: acl("objectAce") }, ME)).toEqual({ kind: "opaque_grant" });
		expect(privacyFault({ owner: USER, dacl: acl("callbackAce") }, ME)).toEqual({ kind: "opaque_grant" });
	});
	test("inherit-only grants and denials don't open the object itself", () => {
		expect(privacyFault({ owner: USER, dacl: acl("inheritOnlyOthers") }, ME)).toBeUndefined();
		expect(privacyFault({ owner: USER, dacl: acl("denyEveryone") }, ME)).toBeUndefined();
	});
	test("refusals say why", () => {
		expect(describeFault({ kind: "shared", trustees: ["S-1-1-0"] })).toMatch(/must not be accessible to other users \(DACL grants S-1-1-0\)/);
		expect(describeFault({ kind: "owner", owner: "S-1-5-18" })).toMatch(/owned by S-1-5-18/);
	});
	test("the descriptors the bridge creates are the ones Noli creates", () => {
		expect(privateFileSddl(USER, false)).toBe(DACL.privateFile!.sddl);
		expect(privateFileSddl(USER, true)).toBe(DACL.privateDir!.sddl);
		expect(privatePipeSddl(USER)).toBe(`O:${USER}D:P(A;;GA;;;${USER})`);
	});
});
