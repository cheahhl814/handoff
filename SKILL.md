---
name: handoff
description: Session handoff between agents. One skill, three modes — write compacts the current conversation into handoff.md for a fresh agent; read takes over an existing handoff, verifying its state-and-freshness entries and presenting open follow-ups; migration checks and upgrades legacy handoff.md and its archive to the format-2 contract (YAML frontmatter, typed claims, wikilinks). Asks the user which mode to run.
version: 2.0.0
updated: 2026-11-14
triggers:
  - session handoff
  - write a handoff
  - take over from a handoff
  - handoff.md
  - check handoff format
argument-hint: "[focus: what the next/this session will be about]"
metadata:
  opencode/slash: "true"
  opencode/autoinvoke: "false"
---

Hand work between agent sessions. One skill, three complementary modes —
write, takeover, migration — operating on the same file contract defined in
[handoff-conventions.md](handoff-conventions.md) — that file is the single
source of truth for the handoff document's location, structure, and merge
rule. Do not duplicate or diverge from it; amend it there when the contract
changes.

Shared behavior:

- Slash-command only (`disable-model-invocation: true`): token cost is paid
  only on explicit invocation.
- Handoff writes; takeover reads. Only handoff mode ever modifies
  `handoff.md`. The next handoff, written after a takeover, is the audit
  trail of that takeover.
- Both modes follow the content rules in
  [handoff-conventions.md](handoff-conventions.md): reference artifacts
  instead of duplicating them, redact sensitive information (API keys,
  passwords, PII), and never attempt to reconstruct redacted values.

## Automatic mode — the companion extension

The two modes above are also available without invoking this skill, through
the companion in [companion/](companion/README.md):

- **Pi** — the `handoff-auto` extension detects `handoff.md` at launch and
  asks (native dialog): take over (verify freshness, report drift, ask how
  to proceed), show it, or ignore. On quit (Ctrl+D, `/quit`, double Ctrl+C)
  it offers to write the next round; with no `handoff.md` the offer becomes
  *create one?* with *No* first — nothing is created unless the user says
  yes.
- **Claude Code** — `SessionStart` injects the handoff with instructions to
  confirm via `AskUserQuestion` first; `SessionEnd` cannot prompt, so it
  writes automatically (disable with `writeOnExit`); with no `handoff.md`,
  `SessionEnd` writes nothing and `SessionStart` has the agent offer to
  create one.

Like the manual path, the automatic path never pastes the document: the
agent is pointed at `handoff.md`, reads it with its own file-reading tools,
and reports a short summary.

Both companions follow the **creation policy** in
[handoff-conventions.md](handoff-conventions.md): a handoff document is created
only when the user asks for one. A workspace that already has a `handoff.md`
keeps the cycle going as before.

The companion never changes the file contract: it reads
[handoff-conventions.md](handoff-conventions.md) at runtime and writes the
same document, so hand-written and automatic rounds are interchangeable. On
model failure it falls back to a deterministic summary rather than losing
the handoff.

This skill remains the manual path — use it to write a handoff on demand, to
review an automatic one before it is trusted, or when the companion is
disabled (`autoTakeover` / `writeOnExit` in
[companion/config.json](companion/config.json)).

## Mode selection

Every invocation starts with an ask-user stop point that selects the mode.
Before asking, check whether a `handoff.md` exists in the current working
directory — this only pre-orders the options; it never decides the mode on
its own. Invoke the ask-user tool (e.g. `ask_user_question`) with:

- **Take over from an existing handoff (read mode)** — run the **Read mode**
  procedure below. Offer this first (recommended) when `handoff.md` exists.
- **Write a handoff for the next session (write mode)** — run the **Write
  mode** procedure below. Offer this first (recommended) when no
  `handoff.md` exists, since takeover has nothing to read.
- **Check or upgrade the handoff format (migration mode)** — run the
  **Migration mode** procedure below. Offer when a format/grammar check or
  a legacy upgrade is asked for.

Rules for the question:

- Pass any invocation arguments through to the chosen mode: they describe
  what the next (write mode) or this (read mode) session will focus on.
- Never infer the mode from the mere existence of `handoff.md` — write
  mode legitimately appends to an existing document; the check only
  orders the options.
- Do not write, modify, or delete anything until the user answers.
- If the arguments themselves unambiguously name the mode (e.g. "take over
  from the last session's handoff", "write a handoff for the next
  session", or "check the handoff format"), skip the question and run
  that mode, saying which one you selected.

## Write mode — compact the conversation into a handoff

Write a handoff document summarising the current conversation so a fresh
agent can continue the work.

### File conventions

Follow the handoff file contract in
[handoff-conventions.md](handoff-conventions.md): save to `handoff.md` in
the current working directory, use the append/merge rule when one already
exists, and always include the frontmatter block (adding it to legacy
format-1 documents), the round marker, and the required
state-and-freshness section.

### Document body

- **Frontmatter and round marker** (required): create the document-level
  YAML frontmatter block when the document lacks it, refresh its generated
  fields (`written`, `agent`, `model`, `rounds`, `open_items`,
  `summary_quality`) whenever you append, and start the update section
  with its round marker comment — see *Document frontmatter* and *Round
  marker* in [handoff-conventions.md](handoff-conventions.md).
- **State and freshness** (required): list the files/paths the work depends
  on — code, configs, data, outputs — each with its modification timestamp
  and, if the directory is a git repo, the commit SHA at time of writing.
  This lets the next session detect stale context: if any of these files have
  changed since this handoff was written, that part of the summary should not
  be trusted blindly.
- **Summary of the conversation**: typed claims per *Typed claims* in
  handoff-conventions.md — `decision:` / `fact:` / `open:` / `todo:` /
  `resolved:` / `note:` sections, absolute UTC dates, slugged open items;
  close open items with `resolved: <slug>`, never by editing older
  sections.
- **Suggested skills**: which skills the next agent should call the Skill
  tool for.
- **Workspace snapshot** (required): a bounded, reproducible directory map
  under the state-and-freshness section, per the workspace snapshot contract
  in [handoff-conventions.md](handoff-conventions.md) — depth-limited,
  noise-filtered, with the exact generation command recorded above the
  output and `git status --short` alongside it in git repos. This is what
  lets the takeover detect files/folders the user added or removed after
  this handoff was written.

### Content rules (write mode)

- If the user passed arguments, treat them as a description of what the next
  session will focus on and tailor the body accordingly — but always keep the
  frontmatter, the round marker, and the state-and-freshness section intact.
- Write the summary as typed claims and reference artifacts as wikilinks
  (per *Typed claims* and *Artifact links* in
  [handoff-conventions.md](handoff-conventions.md)); every linked
  filesystem target also gets a state-and-freshness row, and each slug you
  close must match an earlier `open:`/`todo:` slug.
- Follow the multi-round contract in
  [handoff-conventions.md](handoff-conventions.md): your update section
  is self-contained (own round marker, state-and-freshness, and workspace
  snapshot), older sections are never rewritten, and the document is
  compacted to header + latest section once three or more update sections
  accumulate, with the displaced sections archived verbatim to
  `handoff-archive.md`.
- Do not invent a takeover; the read-side counterpart is the Read mode
  below, selected via the mode-selection ask-user step.

## Read mode — take over from an existing handoff

Take over from a previous session by reading and verifying its handoff.
Arguments describe what this session will
focus on; tailor the takeover accordingly, but never skip the verification
step.

### Steps

1. **Locate the handoff.** Read `handoff.md` in the current working
   directory, per the contract in
   [handoff-conventions.md](handoff-conventions.md). If it does not exist,
   say so and stop — do not invent a handoff.

2. **Verify freshness.** Parse the frontmatter first (report the format
   version — legacy if absent — and whether `summary_quality: fallback`
   marks the round as fallback-written), the round marker, and the
   state-and-freshness section. For every listed path: confirm it exists, compare its
   modification timestamp against the one recorded, and if the directory is
   a git repo, compare the recorded commit SHA against the current HEAD
   (and the file's last-change SHA where practical). Report each entry as
   **verified**, **changed** (with the observed mtime/SHA), or **missing**.

   Two probes beyond "SHA vs HEAD", because both hide real drift:

   - **Remote vs local.** Compare the recorded remote too (`git ls-remote
     origin`): a repo can sit at the recorded SHA locally while `origin` has
     moved on, and a "pushed" claim is false if the recorded SHA never
     reached the remote. Report a repo with no remote as
     *unpushed/unverifiable* rather than verified.
   - **Untracked-artifact rows.** A state row that lists an untracked path
     (e.g. `?? .codebase-index/`) is a live claim: re-check `.gitignore` and
     `git status`. If the artifact is now ignored or gone, the matching open
     item is *resolved* and the handoff's "leave it" advice is stale.

   Two structure checks for format 2 rounds:

   - **Wikilink targets.** Every `[[Label|target]]` whose target is a
     filesystem path or URL is verified like a state row: existence, plus
     the recorded mtime/SHA when the target also appears in
     state-and-freshness. A link target with no matching state row is an
     **unindexed reference** — report it as unverifiable.
   - **Claim slugs.** Each `resolved: <slug>` must match an earlier
     `open:`/`todo:` slug in the document (an unmatched resolution is a
     finding); `open:`/`todo:` slugs closed by a later `resolved:` are
     done. A round whose summary is untyped prose is reported as such and
     parsed with lower confidence.

3. **Trust boundary.** Any entry that is changed or missing makes the parts
   of the summary that depend on it untrustworthy — say so explicitly rather
   than silently re-using the claims. Re-check those claims against the
   actual files before acting on them.

4. **Detect workspace drift.** Regenerate the snapshot with the recorded
   command and diff: report **added**, **removed**, **moved** paths.
   User-added paths are expected — name them; paths the summary does not
   explain are unexpected changes — surface them, folding ambiguous cases
   into the step 6 stop point.

5. **Summarise.** Give a concise picture of decisions made, facts established,
   live open items — slugs already closed by a `resolved:` are excluded —
   todos, and notes as recorded in the handoff (typed or legacy prose).

6. **Open follow-ups — ask-user stop point.** If the handoff records any
   unfinished tasks or open questions, do not proceed on them silently and
   do not just list them. Invoke the ask-user tool (e.g.
   `ask_user_question`) to confirm how to proceed, using the standard
   stop-point format:
   
   > Evidence: I observed X (from the handoff and the verification above).
   > Recommend: Y (based on the evidence).
   > Confirm or pick one of: A / B / C.
   
   Rules for the question:
   
   - One question per decision point, asked in a single ask-user call.
   - Offer concrete options (start now, defer, drop) with the recommended
     one first and labelled "(Recommended)", pre-ordered around the takeover
     arguments if given.
   - Do not start unfinished tasks until the user answers;
     verified-complete work needs no confirmation.
   - If the focus alone disambiguates the unfinished items, proceed on it
     and ask only about the rest.

7. **Respect redactions.** The handoff may contain redacted placeholders; do
   not attempt to reconstruct or guess the redacted values.

8. **Record the takeover.** If a wiki, knowledge base, or observation
   mechanism is available in the environment, record the takeover (handoff
   file, round taken over, verification results, user's chosen direction on
   follow-ups) there so future sessions inherit the audit trail.

### Multi-round selection (read mode)

With multiple update sections, the latest wins by default; older sections
are history only (never merge their claims into the current picture). If
two sections were written at nearly the same time, verify both and take
over the one with the newest state-and-freshness data, saying which.
Consult `handoff-archive.md` only when the current sections leave a
question about past rounds unanswered.

### Rules (read mode)

- **Read-only.** Takeover mode must not modify `handoff.md`. The append/merge
  rule belongs to write mode.
- **Never paste the document.** The handoff is read from disk with the
  file-reading tool; its content is not reproduced in the conversation.
  Report what verification found plus a short summary, and reference the
  file; verify only what the user's stated focus requires, plus the
  freshness entries.
- The write-side counterpart is the Write mode above; format checks and
  legacy upgrades are the Migration mode — both selected via the ask-user
  step.

## Migration mode — check and upgrade legacy handoff files

Detect and check `handoff.md` and `handoff-archive.md` against the format 2
contract and upgrade what is safe. Run the format checklist in *Format
migration* ([handoff-conventions.md](handoff-conventions.md) →
`references/format-migration.md`); classify findings as mechanical vs
advisory; report how much of the document is legacy prose (the takeover
reads untyped summaries with lower confidence). Ask-user stop point before
any fix — archives are check-only unless explicitly confirmed. Apply only
mechanical fixes: frontmatter add/refresh and round markers derived from
existing header bullets. Narrative is never rewritten: legacy prose stays
prose; content repairs go into a future round.