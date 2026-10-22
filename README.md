# omp-peers

Native cross-session messaging for [oh-my-pi](https://github.com/can1357/oh-my-pi), using a filesystem mailbox on one machine. Busy peers can receive messages; interrupted turns do not leave reception disabled.

## Install

Install from GitHub:

```bash
omp plugin install "omp-peers@github:jwaldrip/omp-peers"
```

This copies the package into OMP's plugin directory and records it in the plugin manifest, so it does not depend on any checkout staying on disk. Re-run the same command to update to the latest `main`; `omp plugin upgrade` compares package versions and reports a git install as up to date. Restart OMP sessions to load the extension. `/peers` shows discovery and mailbox status. The extension uses the host's TUI library and needs no mailbox daemon or socket service. Live proof has run on OMP 18.11.0 and 18.12.6.

For local development, `omp plugin link .` from a clone works, but the link is a symlink: if that directory is deleted (a cleaned-up worktree, for example), every new session silently starts without peer tools. `omp plugin doctor` reports it as `orphan:omp-peers`. Do not link a worktree for day-to-day use.

When replacing `pi-cross-session`, first run `omp plugin uninstall pi-cross-session`, then install this extension and restart each existing session. Old processes retain their old extension until restarted. The two transports do not interoperate, and old volatile queues are not migrated.

## Tools

- `list_pi`: list other live sessions, including title, reference, working directory, live git branch, and full session ID. Set `include_offline: true` to include recently active offline sessions.
- `send_pi_message`: send `{ target, message, summary? }`. Use a full session ID or `Name [ref]` from `list_pi`; unique ID prefixes and unambiguous names also work. Messages are limited to 64 KiB UTF-8.
- `/peers`: show registered sessions, the mailbox root, and outstanding confirmations.

The reference is the last eight hexadecimal characters of the session ID. UUIDv7 leading characters encode time and often collide for sessions started together; using the random tail reduces that ambiguity. Full IDs remain the definitive address.

Peer messages have a one-line collapsed preview and a width-wrapped expanded body. `@` completion adds peers while preserving the host's file completion and hints. Task subagents use their own OMP communication path and do not register as independent peers.

## Delivery contract

The sender accepts a send only after writing the envelope through a temporary file and atomic rename. The recipient watches its mailbox with a polling fallback and claims messages under a delivery-instance identity.

| Recipient state | Behavior |
|---|---|
| Idle | Submit a peer message that can start a turn. |
| Running | Queue a steer through OMP's normal delivery path. User messages and queues are preserved. |
| Interrupted | Recover an unconsumed message by appending it without starting another turn. A new incoming message can wake the session normally. |
| Offline | Keep the envelope until that same session resumes with `--resume`. |
| Switching or reloading | Retire the outgoing delivery instance, retain its claims, and recover them when the original session is selected again. |

Delivery is **at least once**. OMP 18.11.0 exposes a void submission API, so a canceled preflight or delayed admission can leave a submission's outcome uncertain. The extension retries uncertain attempts with bounded backoff when the recipient is idle and has no pending messages. Rare duplicate wakes remain possible. It checks known transcript identities before replay and filters duplicate or wrong-recipient peer messages from model context; those safeguards do not guarantee exactly-once execution of actions.

Live visibility and durable confirmation are separate. A `message_end` event or in-memory entry establishes acceptance. A `delivered` receipt requires the matching peer-message entry in the recipient's on-disk transcript. Until then, the mailbox retains its recovery source. A missing receipt means queued or unconfirmed, not that the peer refused the message. The sender should not manually resend it.

This covers ordinary process exits and crashes, not power-loss durability. Ephemeral `--no-session` hosts and fresh sessions whose transcript has not materialized can receive live messages but cannot provide persistent-resume confirmation. Disk or permission failures can delay delivery and remain visible through retained mail and optional traces.

## Storage

Default root: `~/.omp/peer-mail`, shared across OMP profiles for the same OS account.

```text
registry/<sessionId>.json
inbox/<sessionId>/<timestamp>-<messageId>.json
inbox/<sessionId>/claimed/<instanceId>/owner.json
inbox/<sessionId>/claimed/<instanceId>/<timestamp>-<messageId>.json
inbox/<sessionId>/released/<retired-instance>/...
delivered/<sessionId>/<timestamp>-<messageId>.json
receipts/<senderSessionId>/<messageId>.json
quarantine/<generated-id>.json
```

Claim records preserve attempts, acceptance, and abort-recovery policy. Malformed records are quarantined with a reason rather than blocking later valid mail. Directories use mode `0700`; files use `0600`. Recovery sources awaiting confirmation are retained.

- `OMP_PEERS_DIR`: override the mailbox root, for example to isolate a test run.
- `OMP_PEERS_TRACE=1`: append diagnostic events to `trace.jsonl` under that root.

Any process running as the same OS user can read the mailbox or impersonate a sender. Messages are framed as collaborator input, never user approval. The extension adds no tool-authorization gate; normal host approval rules still apply.

## Verify

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun scripts/prove-live.ts --extension ./src/index.ts
```

The live proof uses isolated RPC sessions and needs a working OMP binary and model credentials. See [PATH.md](PATH.md) for the scenarios and command options. CI runs the unit suite and typecheck.

## License

MIT
