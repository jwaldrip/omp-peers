# Live Proof: omp-peers

Automated end-to-end verification of native peer messaging between live oh-my-pi sessions.

## Command

```bash
bun scripts/prove-live.ts --extension ~/dev/src/github.com/jwaldrip/omp-peers.worktrees/durable-peer-mailbox/src/index.ts
```

Or when running inside the repository with the default extension location:

```bash
bun scripts/prove-live.ts
```

## Prerequisites

1. oh-my-pi 18.11.0 installed at `/opt/homebrew/bin/omp`.
2. Bun runtime (1.3+).
3. Active auth for configured fast model (`google-antigravity/gemini-3.8-flash`).

## Scenarios Verified

The harness executes five end-to-end scenarios against fresh isolated RPC sessions:

1. **Idle Wake (a)**: Session A prompts its model to send a nonce to Session B using `send_pi_message`. Session B receives a `peer-message` message and starts a turn. Session A receives status `delivered`.
2. **Busy Turn (b)**: Session B is prompted to execute a long bash command. While B is executing the tool, Session A sends a nonce. Session A receives status `queued` or `delivered` (never an error or refusal). Session B receives the message within the same turn after the tool completes.
3. **Abort Handling (c)**: Session B executes a long sleep tool. Session A sends nonce1. Session B is aborted mid-tool via RPC. Nonce1 is persisted visibly as a custom message entry in Session B's session file on disk. Session B does not start a new turn from the aborted message during a 10s quiet observation window. Session A then sends nonce2 while B is idle, and Session B starts a new turn.
4. **Offline Queue and Resume (d)**: Session B process is stopped. Session A sends nonce3 targeting Session B's session ID and receives status `queued_offline`. The message envelope persists in Session B's mailbox inbox on disk. Session B is resumed with `--resume <sessionId>`, claims the message on start, and starts a turn.
5. **Session Naming and Disambiguation (e)**: Two live sessions share the title `SharedWorker`. Sending to `SharedWorker` returns an ambiguous error listing both candidate references as `Name [id8]`. Sending to specific `SharedWorker [id8]` succeeds with delivery. Sending to an unknown target returns `not_found` with suggestions.

## Expected Output

```
====================================================================================================
FINAL RESULTS TABLE
====================================================================================================
Scenario                       Status   Evidence
----------------------------------------------------------------------------------------------------
a. idle wake                   PASS     A tool status=delivered; B emitted peer-message message_end with NONCE_... and started turn
b. busy                        PASS     A status=delivered; B received NONCE_BUSY_... within run after bash tool finished
c. abort                       PASS     nonce1 persisted in B session file; 0 turns started during 10s abort quiet window; nonce2 successfully started turn
d. offline                     PASS     A status=queued_offline; message persisted in inbox; resumed B delivered NONCE_OFFLINE_... and started turn
e. naming                      PASS     Ambiguous error listed both candidates; exact target delivered; unknown target gave not_found
====================================================================================================

ALL SCENARIOS PASSED.
```

Exit code: `0` on success, non-zero on any failure.
