# Peer messaging proof

Run from this repository:

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun scripts/prove-live.ts --extension ./src/index.ts
```

The live command uses `/opt/homebrew/bin/omp` 18.11.0 and `google-antigravity/gemini-3.8-flash` by default. Override with `--omp /path/to/omp` and `--model provider/model`. It needs working model credentials; Bun 1.3+ runs the driver. Omitting `--extension` uses this repository's `src/index.ts`.

The driver creates isolated mailbox/session directories and loads only the specified extension. Each scenario must print `PASS`, the final line must be `ALL SCENARIOS PASSED.`, and the command must exit 0:

| Scenario | Required observation |
|---|---|
| Idle recipient | Sender invokes `send_pi_message`; recipient receives the nonce and starts a turn. |
| Busy recipient | Send is queued or delivered, without refusal; recipient receives it through the running turn. |
| Interrupt and recovery | Message remains in the recipient transcript after interrupt; no peer-triggered restart in the quiet window; a new message wakes it. |
| Offline resume | Envelope remains on disk while recipient is stopped, then arrives when that session resumes. |
| Name collision | Duplicate titles produce distinct references; an exact reference reaches only its intended recipient. |

`delivered` means confirmed in the on-disk transcript. At-least-once retries can duplicate uncertain wakes; the driver does not prove exactly-once action execution. Contract tests separately cover claim ownership, disk confirmation, replay, malformed records, lifecycle fences, and width-safe rendering.

After linking the plugin, exercise normal global extension discovery with the same isolated mailbox and sessions:

```bash
bun scripts/prove-live.ts --omp ./scripts/installed-entry.sh --extension ./src/index.ts
```

The entrypoint removes the driver's explicit-extension flags and executes the installed `/opt/homebrew/bin/omp`. This checks what a newly started session discovers from the global plugin installation.

For same-process switching and restart suppression of already-recorded messages:

```bash
bun scripts/prove-recovery.ts --extension ./src/index.ts
```
