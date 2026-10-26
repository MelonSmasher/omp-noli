import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { forgeReadArguments, forgeReadRejection } from "../src/forge-read-tools";
import { forgeResourceHandle } from "../src/forge-resource-handle";
import { forgeArguments } from "../src/thread-control";
import { forgeWriteArguments, forgeWriteStatusArguments } from "../src/forge-write-tools";
import { sameSchemaText } from "../scripts/schema-text";
import { FORGE_READ_RESOURCES, FORGE_RESOURCE_KINDS } from "../src/forge-schema-selectors";

interface Schema {
 $ref?: string;
 const?: unknown;
 enum?: unknown[];
 oneOf?: Schema[];
 anyOf?: Schema[];
 type?: string | string[];
 properties?: Record<string, Schema>;
 required?: string[];
 minimum?: number;
 minItems?: number;
 minLength?: number;
 items?: Schema;
 $defs: Record<string, Schema>;
}
const load = (kind: string): Schema => JSON.parse(readFileSync(join(import.meta.dir, "..", "protocol", `noli-forge-${kind}-tool.schema.json`), "utf8"));
const readSchema = load("read");
const writeSchema = load("write");

/** Scalar fixtures use the native lower bound, without interpreting provider semantics. */
function minimalScalar(schema: Schema, type: string | undefined): unknown {
 switch (type) {
  case "boolean": return false;
  case "integer": case "number": return schema.minimum ?? 0;
  case "null": return null;
  case "string": return "1".repeat(Math.max(1, schema.minLength ?? 0));
  default: throw new Error(`Unsupported fixture schema: ${JSON.stringify(schema)}`);
 }
}

function minimalType(schema: Schema, root: Schema): unknown {
 const type = Array.isArray(schema.type) ? schema.type.find(type => type !== "null") : schema.type;
 if (type === "object") return Object.fromEntries((schema.required ?? []).map(key => [key, minimal(schema.properties![key]!, root)]));
 if (type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => minimal(schema.items!, root));
 return minimalScalar(schema, type);
}

/** Build a minimal required-field fixture from the native schema, not a second resource list. */
function minimal(schema: Schema, root: Schema): unknown {
 if (schema.$ref) return minimal(root.$defs[schema.$ref.split("/").at(-1)!]!, root);
 if ("const" in schema) return schema.const;
 if (schema.enum) return schema.enum[0];
 const branch = schema.oneOf?.[0] ?? schema.anyOf?.[0];
 if (branch) return minimal(branch, root);
 return minimalType(schema, root);
}

// Native schemas use Rust uint formats; shape fixtures do not reinterpret those formats.
const ajv = new Ajv2020({ strict: false, validateFormats: false, allowUnionTypes: true });
const nativeRead = ajv.compile(readSchema);
const nativeWrite = ajv.compile(writeSchema);

describe("native forge schema transport parity", () => {
 const intents = readSchema.$defs.ForgeReadToolIntent!.oneOf!;
 test("generated selectors exactly match native read and write schemas", () => {
  expect(intents.map(variant => variant.properties!.resource!.const)).toEqual([...FORGE_READ_RESOURCES]);
  expect(readSchema.$defs.ForgeResourceKind!.enum).toEqual([...FORGE_RESOURCE_KINDS]);
  for (const name of ["ForgeResourceHandle", "ForgeResourceKind", "ForgeResourceId", "StableRepositoryId"]) expect(readSchema.$defs[name]).toEqual(writeSchema.$defs[name]);
 });
 for (const intent of intents) {
  const resource = intent.properties!.resource!.const as string;
  test(`every native read resource is admitted: ${resource}`, () => {
   const input = { action: "read", read: minimal(intent, readSchema) };
   expect(nativeRead(input), ajv.errorsText(nativeRead.errors)).toBe(true);
   expect(forgeReadArguments(input)).toBe(true);
   for (const field of ["noli_requester", "caller"]) expect(forgeReadArguments({ ...input, [field]: "main" })).toBe(false);
  });
 }
 test("unknown resources and malformed transport fields name shape errors, not authority changes", () => {
  const input = { action: "read", read: { resource: "unknown_resource", request: {} } };
  expect(forgeReadArguments(input)).toBe(false);
  expect(forgeReadRejection(input)).toBe('Unsupported forge read resource: "unknown_resource"');
  for (const field of ["noli_requester", "caller"]) {
   const injected = { action: "read", read: { resource: "metadata", request: {} }, [field]: "main" };
   expect(forgeReadArguments(injected)).toBe(false);
   expect(forgeReadRejection(injected)).toBe(`Unexpected forge read field: "${field}"`);
  }
 });
 test("all native resource kinds, IDs and resource actions pass both read and write envelopes", () => {
  const handle = minimal(readSchema.$defs.ForgeResourceHandle!, readSchema) as Record<string, unknown>;
  for (const kind of FORGE_RESOURCE_KINDS) {
   const target = { ...handle, kind };
   expect(forgeResourceHandle(target)).toBe(true);
   expect(forgeArguments({ action: "read", handle: target, offline: false })).toBe(true);
   expect(forgeWriteArguments({ target, payload: { kind: "issue" } }, "call")).toBe(true);
  }
  for (const id of readSchema.$defs.ForgeResourceId!.oneOf!) expect(forgeResourceHandle({ ...handle, resource: minimal(id, readSchema) })).toBe(true);
  for (const action of readSchema.$defs.ForgeResourcesRequest!.oneOf!) expect(forgeArguments(minimal(action, readSchema) as Record<string, unknown>)).toBe(true);
  expect(forgeResourceHandle({ ...handle, kind: "unknown_kind" })).toBe(false);
  expect(forgeArguments({ action: "unknown_action" })).toBe(false);
 });
 test("every native write payload and precondition variant remains a native-owned schema", () => {
  for (const variant of writeSchema.$defs.ForgeWriteToolPayload!.oneOf!) {
   const input = { payload: minimal(variant, writeSchema) };
   expect(nativeWrite(input), ajv.errorsText(nativeWrite.errors)).toBe(true);
   expect(forgeWriteArguments(input, "call")).toBe(true);
   for (const field of ["noli_requester", "caller"]) expect(forgeWriteArguments({ ...input, [field]: "main" }, "call")).toBe(false);
  }
  for (const variant of writeSchema.$defs.ForgeMutationPrecondition!.oneOf!) expect(forgeWriteArguments({ payload: { kind: "issue" }, precondition: minimal(variant, writeSchema) }, "call")).toBe(true);
  expect(forgeWriteStatusArguments({ operation_id: "operation" })).toBe(true);
  for (const field of ["noli_requester", "caller"]) expect(forgeWriteStatusArguments({ operation_id: "operation", [field]: "main" })).toBe(false);
 });
});


test("schema text staleness ignores CRLF checkouts but still rejects every other change", () => {
 const selectors = readFileSync(join(import.meta.dir, "..", "src/forge-schema-selectors.ts"), "utf8").replace(/\r\n/g, "\n");
 const crlf = selectors.replace(/\n/g, "\r\n");
 expect(sameSchemaText(crlf, selectors)).toBe(true);
 expect(sameSchemaText(selectors, crlf)).toBe(true);
 expect(sameSchemaText(crlf, crlf)).toBe(true);
 expect(sameSchemaText(crlf.replace('"issues"', '"unknown"'), selectors)).toBe(false);
 expect(sameSchemaText(crlf + " ", selectors)).toBe(false);
 expect(sameSchemaText(crlf.trimEnd(), selectors)).toBe(false);
});
