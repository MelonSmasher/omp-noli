import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** `provider/model` without a trailing `:level` thinking suffix. */
function exactSelector(pattern: string): string | undefined {
	const slash = pattern.indexOf("/");
	if (slash <= 0) return undefined;
	const colon = pattern.lastIndexOf(":");
	return colon > slash ? pattern.slice(0, colon) : pattern;
}

/**
 * A subagent whose agent profile pins exact Noli gateway models must run on one of them.
 * OMP's task executor otherwise spawns it on the parent's model when none resolves,
 * so a pinned profile silently runs as another model. Role aliases (`@task`) and
 * non-gateway selectors keep OMP's own resolution.
 */
export function installSubagentModelGuard(pi: ExtensionAPI): void {
	pi.on("before_subagent_spawn", (event, ctx) => {
		if (event.modelRole !== undefined) return;
		const pinned = event.patterns.map(exactSelector).filter((selector): selector is string => !!selector && selector.startsWith("noli-"));
		if (!pinned.length || pinned.length !== event.patterns.length) return;
		const available = new Set(ctx.modelRegistry.getAvailable().map(model => `${model.provider}/${model.id}`));
		if (pinned.some(selector => available.has(selector))) return;
		return { block: true, reason: `Requested model ${pinned.join(", ")} is not available from Noli; refusing to run agent ${event.agent} on a different model.` };
	});
}
