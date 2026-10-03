import { expect, test } from "bun:test";
// Runtime-only JS avoids typechecking the pinned dependency's implementation sources.
import { AsyncJobManager } from "../node_modules/@oh-my-pi/pi-coding-agent/src/async/job-manager.ts";
import { probeJobCanceller } from "../src/capabilities";
import { createOmpHost } from "../src/omp-host";

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

test.each([false, true])("bridge cancellation drains owned cleanup (already cancelled: %s), not foreign jobs", async alreadyCancelled => {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	const cleanupEntered = Promise.withResolvers();
	const releaseCleanup = Promise.withResolvers();
	const foreignFinished = Promise.withResolvers();
	const aborted = [];
	const own = manager.register("bash", "owned cleanup", async ({ signal }) => {
		try {
			const abortedSignal = Promise.withResolvers();
			signal.addEventListener("abort", abortedSignal.resolve, { once: true });
			await abortedSignal.promise;
			aborted.push("root");
			return "cancelled";
		} finally {
			cleanupEntered.resolve();
			await releaseCleanup.promise;
		}
	}, { ownerId: "root" });
	const foreign = manager.register("bash", "foreign negative control", async ({ signal }) => {
		signal.addEventListener("abort", () => aborted.push("foreign"), { once: true });
		return foreignFinished.promise;
	}, { ownerId: "foreign" });
	const session = {
		isStreaming: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		agent: { peekSteeringQueue: () => [], peekFollowUpQueue: () => [] },
		asyncJobManager: manager,
		getAgentId: () => "root",
		hasPendingAsyncWork: () => manager.getRunningJobs({ ownerId: "root" }).length > 0,
		getAsyncJobSnapshot: () => ({ running: manager.getRunningJobs({ ownerId: "root" }), delivery: { queued: 0 } }),
	};
	const omp = createOmpHost({
		pi: { AgentRegistry: { global: () => ({ get: () => ({ session }), list: () => [], onChange: () => () => {} }) }, VERSION: "native-regression" },
		events: { on: () => () => {} },
		logger: { warn: () => {} },
	});
	omp.adopt({ agent: { kind: "main", id: "root" }, sessionManager: { getSessionFile: () => undefined }, ui: { notify: () => {}, setStatus: () => {} } });
	try {
		expect(await omp.host.cancelJob(foreign)).toBe(false);
		if (alreadyCancelled) expect(manager.cancel(own, { ownerId: "root" })).toBe(true);
		let acknowledged = false;
		const cancellation = omp.host.cancelJob(own).then(result => { acknowledged = true; return result; });
		await cleanupEntered.promise;
		expect(manager.getJob(own).status).toBe("cancelled");
		expect(session.hasPendingAsyncWork()).toBe(false); // Native status alone loses the cleanup.
		expect(acknowledged).toBe(false);
		expect(omp.host.work()).toMatchObject({ settled: false, pendingAsyncWork: true, jobs: [{ id: own, label: "owned cleanup" }] });
		const duplicate = omp.host.cancelJob(own);
		releaseCleanup.resolve();
		expect(await cancellation).toBe(!alreadyCancelled);
		expect(await duplicate).toBe(true);
		expect(omp.host.work()).toMatchObject({ settled: true, pendingAsyncWork: false, jobs: [] });
		expect(manager.getJob(foreign).status).toBe("running");
		expect(aborted).toEqual(["root"]);
	} finally {
		releaseCleanup.resolve();
		foreignFinished.resolve("foreign complete");
		manager.cancel(own, { ownerId: "root" });
		await Promise.all([manager.getJob(own).promise, manager.getJob(foreign).promise]);
		omp.release();
		manager.dispose();
	}
});
