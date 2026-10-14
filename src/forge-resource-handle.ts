const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key));
const decimal = (value: unknown): boolean => typeof value === "string" && /^[1-9][0-9]{0,39}$/.test(value);
const opaque = (value: unknown): boolean => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 2048 && !/\p{Cc}/u.test(value);
const text = (value: unknown): boolean => typeof value === "string" && value.length > 0;

/** Structural check only. The native selected repository/account remains authoritative. */
export function forgeResourceHandle(handle: unknown): boolean {
	if (!record(handle) || !only(handle, ["origin", "account", "repository", "kind", "resource", "web_url"])
		|| !text(handle.origin) || !text(handle.account) || !text(handle.web_url)
		|| typeof handle.kind !== "string" || !["repository", "issue", "comment", "review", "review_thread", "pipeline", "job", "release", "tag", "milestone", "label", "project_item"].includes(handle.kind)) return false;
	const repository = handle.repository;
	if (!record(repository)) return false;
	if (repository.provider === "github") {
		if (!only(repository, ["provider", "repository_id", "node_id"]) || !decimal(repository.repository_id) || !opaque(repository.node_id)) return false;
	} else if (repository.provider === "gitlab") {
		if (!only(repository, ["provider", "project_id"]) || !decimal(repository.project_id)) return false;
	} else return false;
	const resource = handle.resource;
	if (!record(resource)) return false;
	switch (resource.type) {
		case "github": return only(resource, ["type", "id", "node_id", "number"]) && decimal(resource.id)
			&& (resource.node_id == null || opaque(resource.node_id)) && (resource.number == null || decimal(resource.number));
		case "gitlab": return only(resource, ["type", "id", "number"]) && decimal(resource.id) && (resource.number == null || decimal(resource.number));
		case "github_node": return only(resource, ["type", "node_id"]) && opaque(resource.node_id);
		case "gitlab_discussion": return only(resource, ["type", "discussion_id"]) && opaque(resource.discussion_id);
		case "gitlab_release": return only(resource, ["type", "tag_name"]) && opaque(resource.tag_name);
		case "gitlab_board_item": return only(resource, ["type", "board_id", "issue_id"]) && decimal(resource.board_id) && decimal(resource.issue_id);
		case "github_tag": case "gitlab_tag": return only(resource, ["type", "name"]) && opaque(resource.name);
		default: return false;
	}
}
