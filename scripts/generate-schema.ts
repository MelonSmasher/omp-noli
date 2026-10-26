import { readFileSync } from "node:fs";
import { writeSchemaFiles } from "./schema-files";
import { join } from "node:path";
import ts from "typescript";
import { sameSchemaText } from "./schema-text";
import { AGENT_KINDS, AGENT_STATES, CAPABILITY_NAMES, CAPABILITY_REASONS, DEFINITION_SOURCES, DISCOVERY_REASONS, DISCOVERY_STATUSES, ERROR_CODES, JOB_KINDS } from "../src/protocol";

// The existing frame schema remains the wire envelope. Generate the evolving
// agent contracts from their TypeScript declarations, not a second field list.
const root = join(import.meta.dir, "..");
const path = join(root, "protocol/noli-bridge.schema.json");
const schema = JSON.parse(readFileSync(path, "utf8"));
const previous = JSON.stringify(schema);
const program = ts.createProgram([join(root, "src/protocol.ts")], { strictNullChecks: true, target: ts.ScriptTarget.ESNext });
const checker = program.getTypeChecker();
const source = program.getSourceFile(join(root, "src/protocol.ts"))!;
const declarations = new Map(source.statements.filter(ts.isInterfaceDeclaration).map(declaration => [declaration.name.text, declaration]));

type Schema = Record<string, unknown>;
function generate(type: ts.Type): Schema {
	if (type.flags & ts.TypeFlags.Unknown) return {};
	if (type.isUnion()) {
		const parts = type.types.filter(part => !(part.flags & ts.TypeFlags.Undefined));
		if (parts.every(part => part.flags & ts.TypeFlags.BooleanLiteral)) return { type: "boolean" };
		return { anyOf: parts.map(generate) };
	}
	if (type.flags & ts.TypeFlags.StringLiteral) return { const: (type as ts.StringLiteralType).value };
	if (type.flags & ts.TypeFlags.String) return { type: "string" };
	if (type.flags & ts.TypeFlags.Number) return { type: "number" };
	if (type.flags & ts.TypeFlags.BooleanLike) return { type: "boolean" };
	if (type.flags & ts.TypeFlags.Null) return { type: "null" };
	if (checker.isArrayType(type)) return { type: "array", items: generate(checker.getTypeArguments(type as ts.TypeReference)[0]!) };
	if (type.flags & ts.TypeFlags.Object) {
		const required: string[] = [];
		const properties: Record<string, Schema> = {};
		for (const property of type.getProperties()) {
			const declaration = property.valueDeclaration ?? property.declarations?.[0];
			if (!declaration) throw new Error(`No declaration for ${property.name}`);
			properties[property.name] = generate(checker.getTypeOfSymbolAtLocation(property, declaration));
			if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.name);
		}
		return { type: "object", additionalProperties: false, required, properties };
	}
	throw new Error(`Unsupported protocol type: ${checker.typeToString(type)}`);
}
for (const name of ["GatewayBindParams", "GatewayBindResult", "GatewayReadyResult", "GatewayBindRequest", "AgentView", "AgentOutputParams", "AgentOutputResult", "NavigateTreeParams", "GoalBudgetParams", "MemorySearchParams", "MemorySaveParams", "NativeControlResult"]) {
	const declaration = declarations.get(name);
	if (!declaration) throw new Error(`Missing ${name}`);
	schema.$defs[name] = generate(checker.getTypeAtLocation(declaration));
}
for (const [name, values] of Object.entries({ CapabilityName: CAPABILITY_NAMES, CapabilityReason: CAPABILITY_REASONS, AgentKind: AGENT_KINDS, AgentState: AGENT_STATES, DefinitionSource: DEFINITION_SOURCES, DiscoveryReason: DISCOVERY_REASONS, DiscoveryStatus: DISCOVERY_STATUSES, ErrorCode: ERROR_CODES, JobKind: JOB_KINDS })) schema.$defs[name] = { enum: values };
schema.$defs.Capabilities.required = CAPABILITY_NAMES.filter(name => !["host.attach_file", "host.forge_resource", "host.forge_read", "host.forge_write", "host.forge_watch", "host.model_roles"].includes(name));
schema.$defs.Capabilities.properties = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, { $ref: "#/$defs/CapabilityState" }]));
schema.$defs.Capabilities.properties["host.thread_read"] = { allOf: [{ $ref: "#/$defs/CapabilityState" }, { type: "object", properties: { api: { const: "main-only-v2" } } }] };
schema.$defs.Capabilities.properties["host.thread_open"] = { allOf: [{ $ref: "#/$defs/CapabilityState" }, { type: "object", required: ["api"], properties: { api: { const: "main-only-v1" } } }] };
schema.$defs.Capabilities.properties["host.forge_resource"] = { allOf: [{ $ref: "#/$defs/CapabilityState" }, { type: "object", required: ["api"], properties: { api: { const: "session-v2" } } }] };
schema.$defs.Capabilities.properties["host.forge_read"] = { allOf: [{ $ref: "#/$defs/CapabilityState" }, { type: "object", required: ["api"], properties: { api: { const: "session-v2" } } }] };
schema.$defs.Capabilities.properties["host.forge_write"] = { allOf: [{ $ref: "#/$defs/CapabilityState" }, { type: "object", required: ["api"], properties: { api: { const: "session-v2" } } }] };
schema.$defs.Capabilities.properties["host.forge_watch"] = { allOf: [{ $ref: "#/$defs/CapabilityState" }, { type: "object", required: ["api"], properties: { api: { const: "main-only-v1" } } }] };
schema.$defs.Capabilities.properties["host.model_roles"] = { allOf: [{ $ref: "#/$defs/CapabilityState" }, { type: "object", required: ["api"], properties: { api: { const: "session-v1" } } }] };
schema.$defs.CapabilityApi = { enum: ["public", "internal", "main-only-v1", "main-only-v2", "session-v1", "session-v2"] };
const output = schema.$defs.AgentOutputResult;
output.properties.nextOffset = { type: ["integer", "null"], minimum: 0 };
for (const key of ["start", "end"]) output.properties.spans.items.properties[key] = { type: "integer", minimum: 0 };
schema.$defs.AgentOutputParams.properties.offset = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
schema.$defs.AgentOutputParams.properties.limit = { type: "integer", minimum: 1, maximum: 500 };
schema.$defs.AgentOutputParams.properties.revision = { type: "string", minLength: 1, maxLength: 256 };
const results = schema.$defs.Result.anyOf;
if (!results.some((result: Schema) => result.$ref === "#/$defs/AgentOutputResult")) results.push({ $ref: "#/$defs/AgentOutputResult" });
if (!results.some((result: Schema) => result.$ref === "#/$defs/NativeControlResult")) results.push({ $ref: "#/$defs/NativeControlResult" });
for (const name of ["GatewayBindResult", "GatewayReadyResult"]) {
    if (!results.some((result: Schema) => result.$ref === `#/$defs/${name}`)) results.push({ $ref: `#/$defs/${name}` });
}
if (!schema.$defs.ServerFrame.oneOf.some((frame: Schema) => frame.$ref === "#/$defs/GatewayBindRequest")) schema.$defs.ServerFrame.oneOf.push({ $ref: "#/$defs/GatewayBindRequest" });
schema.$defs.GoalBudgetParams.properties.tokenBudget = { anyOf: [{ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }] };
schema.$defs.MemorySearchParams.properties.limit = { type: "integer", minimum: 1, maximum: 1000 };
schema.$defs.NativeControlResult.additionalProperties = true;
schema.$defs.NativeControlResult.anyOf = ["cancelled", "backend", "goal"].map(key => ({ required: [key], properties: { [key]: schema.$defs.NativeControlResult.properties[key] } }));

// An upstream-unavailable method is deliberately not an advertised CapabilityName.
schema.$defs.ErrorBody.description = "Unavailable advertised capabilities carry capability/reason; unsupported native controllers carry code/message only.";
const unsupportedError = { type: "object", additionalProperties: false, required: ["code", "message"], properties: { code: { const: "capability_unavailable" }, message: { type: "string" } } };
if (schema.$defs.ErrorBody.oneOf.length === 2) schema.$defs.ErrorBody.oneOf.push(unsupportedError);

// Noli owns these schemas. Refresh their snapshots explicitly from a Noli
// protocol directory; normal generation/checks remain offline and reproducible.
const nativeSources = ["read", "write"].map(kind => {
 const name = `noli-forge-${kind}-tool.schema.json`;
 const destination = join(root, "protocol", name);
 const source = process.env.NOLI_FORGE_PROTOCOL_DIR ? join(process.env.NOLI_FORGE_PROTOCOL_DIR, name) : destination;
 const text = readFileSync(source, "utf8");
 return { kind, destination, source, text, schema: JSON.parse(text) };
});
const nativeSchemas = Object.fromEntries(nativeSources.map(item => [item.kind, item.schema]));
for (const name of ["ForgeResourceHandle", "ForgeResourceKind", "ForgeResourceId", "StableRepositoryId"]) {
 if (JSON.stringify(nativeSchemas.read.$defs[name]) !== JSON.stringify(nativeSchemas.write.$defs[name])) throw new Error(`Native read/write handle schemas disagree: ${name}`);
}
const resources: string[] = nativeSchemas.read.$defs.ForgeReadToolIntent.oneOf.map((variant: { properties: { resource: { const: string } } }) => variant.properties.resource.const);
const kinds: string[] = nativeSchemas.read.$defs.ForgeResourceKind.enum;
if (![resources, kinds].every(values => values.length > 0 && values.every(value => typeof value === "string") && new Set(values).size === values.length)) throw new Error("Invalid native forge selector schema");
const selectorsPath = join(root, "src/forge-schema-selectors.ts");
const selectors = "// Generated by scripts/generate-schema.ts from Noli's protocol snapshots. Do not edit.\n"
 + `export const FORGE_READ_RESOURCES: readonly string[] = ${JSON.stringify(resources)};\n`
 + `export const FORGE_RESOURCE_KINDS: readonly string[] = ${JSON.stringify(kinds)};\n`;
// Finish preparing every output before any destination can change.
const outputs = [
 ...nativeSources.filter(item => item.source !== item.destination).map(item => ({ path: item.destination, text: item.text })),
 { path: selectorsPath, text: selectors },
 { path, text: `${JSON.stringify(schema, null, 2)}\n` },
];
if (process.argv.includes("--check")) {
 for (const item of nativeSources) {
  if (!sameSchemaText(readFileSync(item.destination, "utf8"), item.text)) throw new Error(`Native forge schema snapshot is stale: ${item.destination}`);
 }
 if (!sameSchemaText(readFileSync(selectorsPath, "utf8"), selectors)) throw new Error("Forge selectors are stale; run bun run schema");
 if (previous !== JSON.stringify(schema)) throw new Error("Protocol schema is stale; run bun run schema");
 console.log("SCHEMA CURRENT");
} else {
 writeSchemaFiles(outputs);
 console.log("SCHEMA GENERATED");
}
