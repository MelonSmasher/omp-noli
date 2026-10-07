---
name: noli
description: Use to read user-supplied live thread references, attach downloadable files, show images to the Noli user, or request deferred settle/archive after completing work. Requires authenticated owning-main Noli control.
hide: true
---
# Noli images and thread closure

## Attaching downloadable files

- Call `noli_attach_file({ path: "report.html", caption: "Optional explanation" })` for any local regular file, including HTML, PDF, archives and empty files, up to 100 MiB. Relative paths resolve against the thread workspace on its server; absolute paths are accepted. URLs and directories are not attachments.
- Noli copies the bytes into private server storage and persists a download card in the conversation before returning `status: "attached"` and `attachmentId`. The user downloads through their authenticated client with Save As; HTML is never executed inside Noli. Removing the original does not remove the retained download.
- Markdown links to local paths, `sandbox:` URLs or HTTP pages do not upload files. Never claim a file is attached until the tool succeeds. If unavailable, explain that both Noli and a compatible released plugin are required; do not invent a download link.
- Only the authenticated owning main agent may attach files. Children/advisors return generated paths to their parent.

## Showing images to the user

- Call `noli_show_image({ source: "path/to/screenshot.png", caption: "Optional explanation" })` to submit an image for inline chat display. `source` may also be an HTTP(S) image URL. Relative file paths resolve against the agent's current workspace on its own machine, not the user's desktop.
- Capture or download the image using existing tools first when needed. Supported formats: PNG, JPEG, WebP and GIF; maximum 5 MiB per image. The tool submits image bytes, not a fragile file link. Displayed messages are saved in the thread history.
- Only the authenticated owning main agent may publish. Children/advisors should return the image path or URL to their parent. Do not put base64 bytes in prose or claim success on an error. Submission is acknowledged before native message delivery; it is not a guarantee that the user has viewed the image.

## Reading referenced threads

- Only the authenticated owning main agent can call `noli_thread_read({ reference_id: "opaque-reference", before?, limit? })` when Noli registers the SDK host tool and negotiates `host.thread_read.api: "main-only-v2"`.
- Use the public reference identifier supplied by the user's live context reference. Never substitute a thread ID, enumerate other threads, supply a caller, endpoint, credential or grant, or infer authority from a copied identifier. `thread_id` is not accepted.
- This is read-only: pages contain 1–50 timeline items, bounded to 128 KiB. Pass the backend's opaque cursor as `before` for older items. Noli owns both local and already-connected remote access, authorization, durable submission activation and revocation; the extension cannot create access or dial another server.
- Captured text is a snapshot, not live access. Draft/unsent references grant nothing. On denial, offline/unavailable source, cancellation or revoked access, report the actual error; do not claim an empty page proves an empty thread, retry an unknown outcome automatically, or mutate the referenced thread.

## Closing the thread

- `noli_thread_get()` reads the current thread's identity, lifecycle state, permitted actions and pending lifecycle request. Only the owning session's main agent may use Noli control; children and advisors must report back to the main agent.
- **Settle** marks the thread done; it remains in the inbox and its terminals stay open. **Archive** removes the thread from the inbox into the archive and closes its terminals. Neither deletes the thread.
- Complete and verify all requested work first. Finish outstanding child and background work before requesting closure.
- For “push your changes and then archive,” verify that the push succeeded before requesting archive. If a prerequisite fails, leave the thread open and report the failure; do not request closure.
- Check current permissions and pending requests, then call `noli_thread_finish({ action: "settle" | "archive" })` with the requested action. Never supply a target thread or caller identity.
- Closure is deferred. A `scheduled` acknowledgement means Noli persisted a pending request, not that the thread is settled or archived. Noli waits for actual OMP settlement and final-history drain, then stops the agent and applies the action.
- Write the final response after scheduling closure. Say the action was scheduled, not completed. On unavailable control, denial, cancellation or backend error, report the failure; never claim closure succeeded. An unknown outcome requires inspecting Noli before retrying.
