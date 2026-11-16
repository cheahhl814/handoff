# handoff-auto — automatic session handoff companion

Companion to the [`handoff`](../SKILL.md) skill (root README: modes, round
format, hard guarantees). The skill owns the **read/write contract**; this
directory makes the two operations automatic so neither the user nor the
model has to invoke `/skill:handoff` by hand.

## Contents

- [What it automates](#what-it-automates)
- [Layout](#layout)
- [The contract stays in one place](#the-contract-stays-in-one-place)
- [Never lose a handoff](#never-lose-a-handoff)
- [Creation policy](#creation-policy)
- [Confirmation and exit offer](#confirmation-and-exit-offer)
- [Install](#install)
- [Configuration](#configuration)
- [Manual escape hatches](#manual-escape-hatches)
- [Tests](#tests)
- [Notes and limits](#notes-and-limits)

## What it automates

| Side              | Pi                                                                                                                                                       | Claude Code                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Takeover at launch | `session_start` → native 3-option dialog; "Take over" sends a real takeover turn                                                                        | `SessionStart` hook → `hookSpecificOutput.additionalContext` (+ headless verification)                              |
| Write at exit      | Ctrl+D / `/quit` / double Ctrl+C are intercepted and a Yes/No offer is shown; then `session_shutdown` writes (nested model call) under the creation policy | `SessionEnd` hook → headless `claude -p` on the transcript, same creation policy                                    |

## Layout

```text
companion/
├── core.cjs        # shared contract logic + CLI (no model calls, no harness code)
├── pi-extension.ts # Pi adapter (session_start / session_shutdown / /handoff-now)
├── claude-hook.cjs # Claude Code adapter (session-start / session-end)
└── config.json     # tunables for both adapters
```

`core.cjs` is the only place that knows the document format. Both adapters
call it as a subprocess, so there is no TS/CJS interop and no shared mutable
state.

## The contract stays in one place

`core.cjs` reads [`../handoff-conventions.md`](../handoff-conventions.md) at
runtime and feeds it to the summariser model. Edit the conventions file and
both harnesses follow the new rules — the companion never duplicates them.

What the core guarantees:

- `handoff.md` in the session working directory; `handoff-archive.md` for
  compacted history.
- Every round appends a self-contained `## <agent> — <UTC date>` section with
  its own header lines, state & freshness table, summary, suggested skills and
  workspace snapshot.
- The snapshot command is recorded directly above its output, so the next
  session can regenerate and diff it.
- Three or more sections ⇒ the older ones move verbatim into
  `handoff-archive.md`.
- A round is identified by an HTML marker (`<!-- handoff-auto:<id> -->`), so
  re-writing the same session updates that round in place instead of
  duplicating it.

> [!NOTE]
> The companion currently emits **format 1** (legacy) rounds. Format-2
> rounds (frontmatter, round markers, typed claims) are written by the
> manual path; legacy rounds remain first-class inputs on the read side,
> per the versioning rule in the conventions file.

## Never lose a handoff

The narrative summary is the only model-dependent part. If the model call
fails, times out or is unavailable, the core writes a deterministic summary
instead (tail of the transcript + the files touched). The state, freshness and
snapshot parts are always computed locally and are never model-dependent.

## Creation policy

**A handoff document is created only when the user asks for one.** This is
part of the contract in [`../handoff-conventions.md`](../handoff-conventions.md),
not a companion detail, and both adapters enforce it:

| Situation                      | Pi                                                                                                                                                            | Claude Code                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace has a `handoff.md`    | Exit offer: *Write a handoff for the next session?* (Yes/No) — unchanged                                                                                     | `SessionEnd` writes the next round automatically                                                                                                       |
| Workspace has no `handoff.md`   | Exit offer: *No handoff.md in this workspace — create one for the next session?* — **No first**, so a stray Enter creates nothing                            | `SessionEnd` writes **nothing** and says so in a `systemMessage`; the `SessionStart` context tells the agent to offer the handoff before the session ends |

In the Pi case an explicit *Yes* is what authorises the write: the shutdown
handler creates the document only when the user confirmed it, when a
`handoff.md` already exists, or when `pi.createIfMissing` is on. The
`SessionEnd` hook in Claude Code skips the write when the workspace has no
handoff, and also when the handoff was already written *during* the session
(the handoff skill ran at the user's request) — one session, one round.

Set `pi.createIfMissing` / `claude.createIfMissing` to `true` to restore the
old behaviour (write at exit even in a workspace that had no handoff).

## Confirmation and exit offer

**Takeover (Pi).** When `handoff.md` exists in a TUI session, a native dialog
offers: *Take over — verify freshness and continue* (a real takeover turn),
*Review the handoff first, don't act yet* (the agent reads the file and
reports a short digest — the document itself is never pasted into the
conversation) and *Ignore for now* (nothing is sent, `handoff.md` untouched).
Esc counts as *Ignore*. In print/JSON mode there is no UI: the takeover stays
a prompt guideline and `pi -p` is never hijacked.

**Takeover (Claude Code).** Hooks cannot open dialogs, so the injected context
starts with an instruction to ask the same three choices with the native
`AskUserQuestion` tool before doing anything else.

> [!IMPORTANT]
> **Nothing is pasted.** Every takeover path ships a *pointer* — the file
> path, the list of rounds, the instructions — never the document body. The
> agent reads `handoff.md` with its own file-reading tool, exactly like a
> manual `/skill:handoff` invocation, and reports a short summary. The
> headless verifier does the same: it is told to read the file, and it may
> only use Read/Grep/Glob.

**Exit offer (Pi).** `session_shutdown` fires after the TUI is stopped, where
dialogs hang, so the offer is shown *before* shutdown: a terminal-input listener
consumes Ctrl+D (empty editor only), `/quit`, and the second Ctrl+C within
500 ms, asks *Write a handoff for the next session?* and then calls
`ctx.shutdown()`. *No* suppresses the write for that shutdown; Esc cancels the
exit (the session stays open, nothing written). Other exits (SIGTERM, closed
terminal, `/new`, any gesture not recognised) still write as before.

**Exit (Claude Code).** `SessionEnd` cannot prompt, so the write stays automatic;
disable it with `writeOnExit: false` and a `systemMessage` reports the file written.

## Install

Point the two adapters into your agent's hook/extension directories (paths
use placeholders — substitute your own):

```bash
# Pi: extension
ln -sfn "<skills directory>/handoff/companion/pi-extension.ts" \
        "<pi extensions dir>/handoff-auto.ts"

# Claude Code: hook
ln -sfn "<skills directory>/handoff/companion/claude-hook.cjs" \
        "<claude hooks dir>/handoff-auto.cjs"
```

Then register the Claude Code hooks in its settings file (`hooks` key):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "node <claude hooks dir>/handoff-auto.cjs session-start", "timeout": 150 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node <claude hooks dir>/handoff-auto.cjs session-end", "timeout": 240 }
        ]
      }
    ]
  }
}
```

> [!IMPORTANT]
> The host's default hook timeout is **1.5 seconds** — the `timeout` field
> is mandatory here or the handoff is cut off mid-write.

Reload Pi (`/reload`) after installing or changing the extension.

## Configuration

`config.json` (all keys optional, shown with their defaults):

| Key | Default | Meaning |
| --- | --- | --- |
| `autoTakeover` | `true` | Detect `handoff.md` and take over on launch. |
| `writeOnExit` | `true` | Write a handoff when the session ends. |
| `takeoverSessionReasons` | `["startup"]` | Pi `session_start` reasons that trigger a takeover. |
| `writeOnExitReasons` | `["quit","new"]` | Pi `session_shutdown` reasons that trigger a write. |
| `sectionsBeforeCompact` | `3` | Sections before older ones are archived. |
| `snapshotDepth` / `snapshotExcludes` | `3` / noise list | Workspace snapshot shape. |
| `pi.useModelSummary` | `true` | Use the session model for the narrative. |
| `pi.summaryTimeoutSec` | `120` | Timeout for the nested pi model call. |
| `pi.checkpointOnSettle` | `true` | Keep a per-directory checkpoint so a killed session still leaves state. |
| `pi.takeoverConfirm` | `true` | Show the takeover dialog (false = take over immediately). |
| `pi.exitOffer` | `true` | Show the exit write-offer (false = always write silently). |
| `pi.createIfMissing` | `false` | Write at exit even when the workspace has no `handoff.md`. |
| `claude.takeoverConfirm` | `true` | Inject an `AskUserQuestion` confirmation instruction. |
| `claude.optInNotice` | `true` | Tell the agent how to offer a handoff when the workspace has none. |
| `claude.createIfMissing` | `false` | Write at session end even when the workspace has no `handoff.md`. |
| `claude.takeoverMode` | `"verify"` | `verify` (headless check), `inject` (instant, no model call) or `off`. |
| `claude.verifyTimeoutSec` | `90` | Timeout for the headless verification. |
| `claude.writeTimeoutSec` | `180` | Timeout for the headless summary at session end. |
| `claude.model` | `null` | Model for the headless calls (null = harness default). |
| `claude.sessionStartSources` | `["startup"]` | Claude Code session sources that trigger a takeover. |
| `claude.sessionEndReasons` | `["clear","logout","prompt_input_exit","other"]` | Session-end reasons that trigger a write. |

Set `HANDOFF_AUTO_CONFIG` to point at an alternative config file, and
`HANDOFF_AUTO_CORE` to relocate the core script.

## Debugging a silent launch

Every quiet decision the Pi extension makes is logged to
`~/.pi/agent/handoff-auto.log` (override with `HANDOFF_AUTO_LOG`): takeover
skipped (wrong `session_start` reason, `autoTakeover` off), core unreachable,
core error, or `no-sections` (the file exists but no round could be parsed).
Check this file first when a launch shows no takeover dialog.

Round boundaries are recognised either by a `## <agent> — <date>` heading or by
a bare `<!-- round: ... -->` marker, so hand-written format-2 documents that
carry only the marker are read fine. A marker directly under an H2 (nothing
but blank lines between) is treated as that round's metadata, not as a new
round.

## Manual escape hatches

- Pi: `/handoff-now` writes a handoff immediately (same format as the exit
  handoff).
- Pi: `/skill:handoff` still works — the skill is the manual, reviewable path.
- Core CLI (debugging):

```bash
node "<skills directory>/handoff/companion/core.cjs" takeover      --cwd "$PWD"
node "<skills directory>/handoff/companion/core.cjs" handoff-exists --cwd "$PWD"
node "<skills directory>/handoff/companion/core.cjs" state         --cwd "$PWD"
node "<skills directory>/handoff/companion/core.cjs" write         --cwd "$PWD" --agent pi --summary-file /tmp/s.md
```

## Tests

`tests/` holds two regression harnesses for the creation policy:

```bash
# Claude Code hook: session-start notice, no-write on a fresh workspace,
# round appended when a handoff exists, no duplicate round per session.
bash companion/tests/hook-policy-test.sh

# Pi, in a real PTY: fresh+No, fresh+Yes, existing+No, existing+Yes.
python3 companion/tests/pty-policy-test.py
```

The PTY harness drives a real agent session in a scratch directory, so it
needs a working model and takes a few minutes; the hook harness runs in
seconds.

## Notes and limits

- The headless summary children run with `HANDOFF_AUTO_IN_CHILD=1` so the
  hooks never recurse, and without the host's nesting-detection env vars.
- Subagent sessions (`agent_id` in the hook payload) neither take over nor
  hand off.
- After *Take over*, the Pi takeover message is a real user message: the agent verifies
  freshness, reports drift and asks the user how to proceed before it starts
  any unfinished work. Claude Code cannot start a turn from `SessionStart`, so
  there the takeover arrives as context and runs on the first prompt (in
  `verify` mode the verification has already happened by then).
- The Claude Code write path costs one headless model call per session end;
  the Pi write path costs one nested call on the session's own model.

## Provenance

Ships with the `handoff` skill (see its root README for provenance and the
format-2 contract). Built as the optional automatic layer of the same
document contract; the contract itself is never duplicated here.
