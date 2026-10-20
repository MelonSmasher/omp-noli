/**
 * Worker for ./windows-native: blocks in `WaitForMultipleObjects` on the auto-reset wake event
 * plus every armed operation event, and posts the slot of each one that fires. A fired slot is
 * disarmed before it is posted, so the main thread may close its event; it re-arms by storing
 * the event and setting the wake event. Windows only.
 */
import { dlopen, FFIType } from "bun:ffi";

declare const self: Worker;

const kernel32 = dlopen("kernel32.dll", {
	WaitForMultipleObjects: { args: [FFIType.u32, FFIType.ptr, FFIType.i32, FFIType.u32], returns: FFIType.u32 },
	GetLastError: { args: [], returns: FFIType.u32 },
}).symbols;

const INFINITE = 0xffff_ffff;
const WAIT_FAILED = 0xffff_ffff;

self.onmessage = (message: MessageEvent<{ shared: SharedArrayBuffer; wake: number; slots: number }>) => {
	const { shared, wake, slots } = message.data;
	const events = new BigInt64Array(shared, 0, slots);
	const armed = new Int32Array(shared, slots * 8, slots);
	const handles = new BigInt64Array(slots + 1);
	const slotOf = new Int32Array(slots + 1);
	for (;;) {
		handles[0] = BigInt(wake);
		let count = 1;
		for (let slot = 0; slot < slots; slot++) {
			if (Atomics.load(armed, slot) !== 1) continue;
			handles[count] = Atomics.load(events, slot);
			slotOf[count++] = slot;
		}
		const fired = kernel32.WaitForMultipleObjects(count, handles, 0, INFINITE);
		if (fired === WAIT_FAILED || fired >= count) {
			postMessage(`WaitForMultipleObjects returned ${fired} (Win32 error ${kernel32.GetLastError()})`);
			return;
		}
		if (fired === 0) continue;
		const slot = slotOf[fired]!;
		Atomics.store(armed, slot, 0);
		postMessage(slot);
	}
};
