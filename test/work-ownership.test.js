import { expect, test } from "bun:test";
// Runtime-only JS avoids typechecking the pinned dependency's implementation sources.
import { AsyncJobManager } from "../node_modules/@oh-my-pi/pi-coding-agent/src/async/job-manager.ts";
import { probeJobCanceller } from "../src/capabilities";

test("native job cancellation aborts only jobs owned by the root session", async () => {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	const aborted = [];
	const started = [];
	const register = (ownerId) => {
		const ready = Promise.withResolvers();
		started.push(ready.promise);
		return manager.register("bash", "controlled ownership regression", async ({ signal }) => {
			const completion = Promise.withResolvers();
			signal.addEventListener("abort", () => {
				aborted.push(ownerId);
				completion.resolve("cancelled");
			}, { once: true });
			ready.resolve();
			return completion.promise;
		}, { ownerId });
	};
	const own = register("root"), foreign = register("other");
	try {
		await Promise.all(started);
		const probe = probeJobCanceller({ asyncJobManager: manager, getAgentId: () => "root" });
		if (!probe.ok) throw new Error(probe.detail);
		expect(probe.value.manager.cancel(foreign, { ownerId: probe.value.ownerId })).toBe(false);
		expect(manager.getJob(foreign)?.status).toBe("running");
		expect(probe.value.manager.cancel(own, { ownerId: probe.value.ownerId })).toBe(true);
		expect(manager.getJob(own)?.status).toBe("cancelled");
		expect(aborted).toEqual(["root"]);
	} finally {
		manager.cancel(own, { ownerId: "root" });
		manager.cancel(foreign, { ownerId: "other" });
		manager.dispose();
	}
});
