import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
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
for (const name of ["AgentView", "AgentOutputParams", "AgentOutputResult", "NavigateTreeParams", "GoalBudgetParams", "MemorySearchParams", "MemorySaveParams", "NativeControlResult"]) {
	const declaration = declarations.get(name);
	if (!declaration) throw new Error(`Missing ${name}`);
	schema.$defs[name] = generate(checker.getTypeAtLocation(declaration));
}
for (const [name, values] of Object.entries({ CapabilityName: CAPABILITY_NAMES, CapabilityReason: CAPABILITY_REASONS, AgentKind: AGENT_KINDS, AgentState: AGENT_STATES, DefinitionSource: DEFINITION_SOURCES, DiscoveryReason: DISCOVERY_REASONS, DiscoveryStatus: DISCOVERY_STATUSES, ErrorCode: ERROR_CODES, JobKind: JOB_KINDS })) schema.$defs[name] = { enum: values };
schema.$defs.Capabilities.required = [...CAPABILITY_NAMES];
schema.$defs.Capabilities.properties = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, { $ref: "#/$defs/CapabilityState" }]));
const output = schema.$defs.AgentOutputResult;
output.properties.nextOffset = { type: ["integer", "null"], minimum: 0 };
for (const key of ["start", "end"]) output.properties.spans.items.properties[key] = { type: "integer", minimum: 0 };
schema.$defs.AgentOutputParams.properties.offset = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
schema.$defs.AgentOutputParams.properties.limit = { type: "integer", minimum: 1, maximum: 500 };
const results = schema.$defs.Result.anyOf;
if (!results.some((result: Schema) => result.$ref === "#/$defs/AgentOutputResult")) results.push({ $ref: "#/$defs/AgentOutputResult" });
if (!results.some((result: Schema) => result.$ref === "#/$defs/NativeControlResult")) results.push({ $ref: "#/$defs/NativeControlResult" });
schema.$defs.GoalBudgetParams.properties.tokenBudget = { anyOf: [{ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }] };
schema.$defs.MemorySearchParams.properties.limit = { type: "integer", minimum: 1, maximum: 1000 };

// An upstream-unavailable method is deliberately not an advertised CapabilityName.
schema.$defs.ErrorBody.description = "Unavailable advertised capabilities carry capability/reason; unsupported native controllers carry code/message only.";
const unsupportedError = { type: "object", additionalProperties: false, required: ["code", "message"], properties: { code: { const: "capability_unavailable" }, message: { type: "string" } } };
if (schema.$defs.ErrorBody.oneOf.length === 2) schema.$defs.ErrorBody.oneOf.push(unsupportedError);
if (process.argv.includes("--check")) {
	if (previous !== JSON.stringify(schema)) throw new Error("Protocol schema is stale; run bun run schema");
	console.log("SCHEMA CURRENT");
} else {
	writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`);
	console.log("SCHEMA GENERATED");
}
