---
name: noli
description: Use when the user asks the owning Noli thread's main agent to mark work done (settle) or archive the thread after completing work. Requires authenticated Noli control.
hide: true
---
# Noli thread closure

- `noli_thread_get()` reads the current thread's identity, lifecycle state, permitted actions and pending lifecycle request. Only the owning session's main agent may use Noli control; children and advisors must report back to the main agent.
- **Settle** marks the thread done; it remains in the inbox and its terminals stay open. **Archive** removes the thread from the inbox into the archive and closes its terminals. Neither deletes the thread.
- Complete and verify all requested work first. Finish outstanding child and background work before requesting closure.
- For “push your changes and then archive,” verify that the push succeeded before requesting archive. If a prerequisite fails, leave the thread open and report the failure; do not request closure.
- Check current permissions and pending requests, then call `noli_thread_finish({ action: "settle" | "archive" })` with the requested action. Never supply a target thread or caller identity.
- Closure is deferred. A `scheduled` acknowledgement means Noli persisted a pending request, not that the thread is settled or archived. Noli waits for actual OMP settlement and final-history drain, then stops the agent and applies the action.
- Write the final response after scheduling closure. Say the action was scheduled, not completed. On unavailable control, denial, cancellation or backend error, report the failure; never claim closure succeeded. An unknown outcome requires inspecting Noli before retrying.
