/** Git may check out generated text as CRLF; every other byte still participates in staleness. */
export function sameSchemaText(actual: string, expected: string): boolean {
	return actual.replace(/\r\n/g, "\n") === expected.replace(/\r\n/g, "\n");
}
