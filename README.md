# omp-peers

Durable cross-session peer messaging for oh-my-pi (omp) sessions on one machine.

`omp-peers` is a native OMP extension that allows multiple concurrent omp sessions on the same workstation to discover and message one another reliably. It replaces socket-based implementations with an atomic filesystem mailbox that handles busy recipients, interrupted runs, and offline sessions without dropping messages.

## Key Capabilities

- **Always Deliverable**: Messages sent to active or busy sessions are never refused.
- **Idle Wake**: Sending to an idle recipient immediately begins a new turn.
- **Mid-Turn Steer**: Sending to a streaming recipient injects the message at the next step boundary without aborting user turns.
- **Abort Resilient**: Messages in flight when a run is interrupted or aborted via Esc are safely persisted into the session transcript without triggering runaway turns. A subsequent user prompt or peer message wakes the session normally.
- **Offline Queuing**: Messages sent to an offline session are stored on disk and delivered automatically when resumed with `--resume`. Messages to a session that never produced output cannot be delivered, because omp only persists a session file after its first real write, so `--resume` has nothing to resume.
- **Drop-In Compatibility**: Exposes `list_pi` and `send_pi_message` with identical argument contracts.
- **Subagent Isolation**: Task subagents automatically exclude themselves from registration and tool exposure, preventing clutter.

## Installation

Clone or download the repository, then link it using the omp plugin CLI:

```bash
omp plugin link /path/to/omp-peers
```

Verify that the tools are available inside any active omp session:

```text
/peers
```

## Tools and Commands

### `list_pi`
Lists all known sessions on the local machine:
- `include_offline` (boolean, optional): include offline sessions active within the last 7 days.

Output format:
```text
Name [ref] - idle|busy|offline - <cwd> - <branch> - session <sessionId> - active <N>s ago
```

The display reference `[ref]` consists of the last 8 hexadecimal characters of the session ID (hyphens stripped). OMP session IDs are UUIDv7 values whose timestamp-based leading characters collide for sessions started within about a minute. The trailing characters contain the random component and uniquely distinguish concurrent sessions.

The git branch is resolved live from the session working directory's git HEAD at query time (handling linked worktree gitdir pointers) rather than stored statically in the registry.

### `send_pi_message`
Sends a message to another session:
- `target` (string, required): recipient session ID, `Name [ref]`, `@Name [ref]`, unique prefix (at least 4 hex characters), or exact name.
- `message` (string, required): message body (up to 64 KiB UTF-8).
- `summary` (string, optional): short summary for collapsed TUI display.

Resolution order:
1. Exact session ID.
2. `Name [ref]` or `@Name [ref]`.
3. Unique session ID prefix (at least 4 characters, hyphens ignored).
4. Exact case-insensitive session title.
5. Unique case-insensitive substring match among live sessions.

### `/peers`
Slash command that prints registered peers, current mailbox directories, and pending inbox/outbox counts.

## Delivery Flow

The delivery state machine operates over the filesystem mailbox:

1. **Send**: The sender writes an atomic message envelope into `inbox/<recipientSessionId>/<timestamp>-<id>.json`.
2. **Claim**: The recipient watches its inbox directory with filesystem events and fallback polling. It atomically claims the oldest file by renaming it into `inbox/<recipientSessionId>/claimed/<pid>/<timestamp>-<id>.json`.
3. **Dispatch**:
   - If the recipient is idle, the message is dispatched with turn triggering (mode: `woke`). Only one message is claimed per pass so subsequent messages steer into the running turn.
   - If the recipient is currently streaming, the message is queued as a steer (mode: `steered`).
4. **Receipt**: Once acknowledged by session message events or confirmed in the session store, the message is moved to `delivered/` and a delivery receipt is written to `receipts/<senderSessionId>/<id>.json`.
5. **Abort Recovery**: If an active turn ends due to an interrupt or abort, unacknowledged in-flight messages are re-submitted visibly without triggering a turn (mode: `appended`) once the session is verified idle, with duplicate suppression backoff.

## Storage Layout

By default, mailbox files reside under `~/.omp/peer-mail`:

```text
~/.omp/peer-mail/
  registry/
    <sessionId>.json            # Liveness, heartbeat, status, cwd (branch is resolved live)
  inbox/
    <sessionId>/
      <timestamp>-<id>.json     # Pending message envelopes
      claimed/
        <pid>/
          <timestamp>-<id>.json # Atomic claim lock by recipient process
  delivered/
    <sessionId>/
      <timestamp>-<id>.json     # Delivered message archive (pruned after 7 days)
  receipts/
    <sessionId>/
      <id>.json                 # Delivery receipts for sender confirmation
```

All writes use atomic temporary-file-and-rename mechanics with restricted file modes (0700 directories, 0600 files).

## Trust Boundary

Any process running under the same operating system user account has filesystem access to read or write mailbox files and could technically claim any sender identity. The extension structurally frames every peer message as coming from another local session, never as the user's explicit authorization. Peer messages do not grant tool approval or override security gates.

## Environment Variables

- `OMP_PEERS_DIR`: overrides the root mailbox path (default: `~/.omp/peer-mail`).
- `OMP_PEERS_TRACE`: set to `1` to write structured execution traces to `trace.jsonl` in the mailbox directory.

## Migration from pi-cross-session

`omp-peers` replaces `pi-cross-session` directly:

1. Uninstall the old extension:
   ```bash
   omp plugin uninstall pi-cross-session
   ```
2. Link `omp-peers`:
   ```bash
   omp plugin link /path/to/omp-peers
   ```
3. No daemon or socket processes are required. Existing skills, prompts, and habits using `list_pi` and `send_pi_message` continue to work without modification.

## Development

Run unit tests:
```bash
bun test
```

Run type check:
```bash
bun run typecheck
```

## License

MIT
