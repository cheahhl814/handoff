# Handoff file contract

Shared conventions for the `handoff` and `takeover` sub-skills. This file is
the single source of truth for the handoff document's location, structure,
and merge rule.

## File name and merge rule

The handoff lives at `handoff.md` in the current working directory (the
directory the agent was launched from). This fixed filename matters: future
sessions and harness hooks look for `handoff.md` at that exact path when
priming themselves.

## Creation policy

A handoff document is **created only when the user asks for one**. A session
that finds no `handoff.md` in its working directory must not leave one behind
when it ends, unless the user explicitly requested a handoff during that
session (the handoff skill's write mode, an exit offer answered "yes", or the
equivalent in the harness at hand). Silently seeding a workspace with a
handoff pollutes directories that never wanted one and makes the next session
take over a document nobody asked for.

A workspace that already carries a `handoff.md` is in the handoff cycle: the
next round is appended as usual.

If `handoff.md` already exists in the working directory, do not overwrite it.
Append an update section under a level-2 heading named
`## <agent-or-harness-name> — <UTC date>` (e.g. `## pi — 2026-09-19`), so
concurrent agents sharing the workspace never clobber each other's entries.
Only create a fresh document when none exists.

## Document structure (write-side contract)

The document is one YAML frontmatter block followed by append-only update
sections. Every update section is self-contained — its own round marker
and its own body — so the takeover can verify any round in isolation.

The contract is versioned: frontmatter `format: 2` enables the grammar
below; a document without frontmatter is a **legacy (format 1)** document —
still fully readable and appendable, and upgraded by the next write-mode
round, which adds the frontmatter block. Upgrading is bookkeeping: older
sections' narrative text is never touched.

### Document frontmatter

The first round creates the document with this block; later rounds refresh
its generated fields in place (refreshing frontmatter is bookkeeping, not
a narrative rewrite — body sections remain append-only):

```yaml
---
type: handoff
format: 2
written: 2026-11-14T14:05:23Z    # UTC, set by the latest round
agent: pi                        # latest round's harness
model: ollama-cloud/minimax-m3.1-flash
rounds: 3                        # update sections, latest included
open_items: 4                    # live open:/todo: claims minus resolved:
summary_quality: model           # model | fallback (automatic writers)
redacted: false                  # true once sensitive values were redacted
---
```

`rounds`, `open_items` and `written` are computed values: if the writer
cannot compute them exactly, it must omit the field rather than guess.

### Round marker

Each update section begins with an HTML comment carrying its metadata:

```markdown
<!-- round: agent=pi model=ollama-cloud/minimax-m3.1-flash written=2026-11-14T14:05:23Z -->
```

Automatic writers may carry their existing marker as an extra key (e.g.
`handoff-auto=pi:mvs6s3oy`); a bare legacy `<!-- handoff-auto:<agent>:<id>
-->` comment is equally valid. Manual rounds written before format 2 have
no marker — expected, not a defect.

After the marker, record the user's "next session" description, if
arguments were passed. Then the body, containing:

- **State and freshness** (required): list the files/paths the work depends
  on — code, configs, data, outputs — each with its modification timestamp
  and, if the directory is a git repo, the commit SHA at time of writing.
  This lets the next session detect stale context: if any of these files have
  changed since this handoff was written, that part of the summary should not
  be trusted blindly.
- **Summary of the conversation**: typed claims per *Typed claims* below —
  `decision:` / `fact:` / `open:` / `todo:` / `resolved:` / `note:`
  sections; legacy prose summaries remain valid and readable.
- **Suggested skills**: which skills the next agent should call the Skill
  tool for.
- **Workspace snapshot** (required): a bounded, reproducible map of the
  working directory, so the takeover can detect files/folders added or
  removed after this handoff was written. Format and limits below.

### Typed claims

The summary section is a sequence of typed claims — one claim per `####`
section, and the heading is the claim:

```markdown
### Summary of the conversation

#### decision: takeover requires explicit user confirmation
Pi's ctx.ui.select() hangs during session_shutdown, so the takeover dialog
intercepts terminal input instead (see [[pi-extension|/abs/path/companion/pi-extension.ts]]).

#### fact: nine PTY scenarios passed on 2026-10-28
Covered takeover choices, exit-offer Yes/No, /quit, Esc, double Ctrl+C, pi -p.

#### open: inject-mode-behaves-like-verify
Documented `inject` takeover mode behaves like `verify`.
See [[takeover-spec|/abs/path/to/takeover-spec.md]].

#### todo: verify-claude-hook-in-real-session
Claude Code five-hour account limit blocked the end-to-end run on 2026-10-28.

#### resolved: creation-policy-opt-in
Settled 2026-10-28 (second round): no handoff.md is created without the user asking.

#### note: state-and-freshness and snapshots are computed locally, never by the model
```

Types are closed: `decision:`, `fact:`, `open:`, `todo:`, `resolved:`,
`note:`. Rules:

- One claim per `####` section; anything that fits no type is dropped —
  noise is the enemy.
- Absolute UTC dates only — never "yesterday" or "earlier today".
- `open:` and `todo:` headings carry a short kebab-case slug (a few
  words); `resolved: <slug>` closes exactly that slug in a later round.
- `resolved:` may only reference a slug that exists in an earlier
  `open:`/`todo:` section, and records when and how the item settled,
  with evidence links. Older sections are never edited.
- A claim superseded by later information is superseded by a new claim in
  a later round — never by editing the old one.
- Model summaries (manual or automatic) SHOULD use this grammar. An
  untyped (prose) summary is still valid; the takeover reports it as
  untyped and parses it with lower confidence.

### Artifact links

References to artifacts — specs, plans, ADRs, issues, commits, diffs,
wiki pages — are wikilinks, never bare paths dropped into prose:

- `[[Label|/absolute/path]]` and `[[Label|https://…]]` for files and URLs:
  the target is required and machine-checkable, the label is the readable
  handle.
- `[[claim-slug]]` (no target) cross-references an `open:`/`todo:`/
  `resolved:` slug within the same document.
- Every linked filesystem artifact must also appear as a row in the
  state-and-freshness section: the link is the handle, the row is the
  verification record.
- Redaction rules apply to link labels and targets exactly as to prose;
  the takeover must not reconstruct redacted values.

## Workspace snapshot contract

The snapshot must be reproducible — the takeover regenerates it with the
same command and diffs the two. Rules:

- Generate with a depth-limited, noise-filtered listing, e.g.
  `tree -L 3 --dirsfirst -I '.git|node_modules|__pycache__|.venv|venv|dist|build'`
  (fall back to `find . -maxdepth 3 -not -path '*/.git*' …` when `tree` is
  unavailable). Record the exact command used on a line directly above the
  output.
- Exclude generated/vendored content by default (VCS internals, dependency
  caches, build/dist outputs). Extend the exclude list rather than shipping
  noise.
- Cap size: if the listing exceeds ~200 lines, raise the depth cap, widen
  the excludes, or record only the top two levels plus the directories the
  session actually touched. Note any truncation explicitly.
- In a git repo, complement the snapshot with `git status --short` output
  (tracked changes and untracked files); the snapshot then mainly documents
  structure, and `git status` detects drift.
- Put the snapshot in a fenced code block under the `### Workspace snapshot`
  heading of the state-and-freshness section, so it is easy to locate and
  diff.

## Multi-round contract

The handoff → takeover → handoff cycle repeats against the same
`handoff.md`:

- **Each round appends.** Handoff never rewrites previous sections; the
  document is a chronological audit trail. The state-and-freshness entries
  and workspace snapshot in each section reflect that round's write time —
  never refresh or back-port data into older sections.
- **Compaction.** When a handoff would add its section to a document that
  already has three or more update sections, archive the older sections
  first: move them verbatim to `handoff-archive.md` (creating it if needed,
  appending, same no-overwrite rule) and keep in `handoff.md` only the
  header block plus the most recent update section. Note the archive and
  section count in the new section (e.g. "prior rounds: 3, archived to
  handoff-archive.md"). `handoff.md` stays small and current; the full
  history survives in the archive.
- **Concurrent rounds.** If two agents hand off at nearly the same time,
  both sections land in the document in append order. Takeover resolves the
  ambiguity: verify both sections' freshness entries and take over from
  whichever section's state-and-freshness data is newest — say explicitly
  that two rounds were written and which one you are taking over from.

## Verification targets (read-side contract)

The handoff document is **never pasted into the conversation** — not by the
takeover sub-skill, not by the companion's automatic takeover. The reader is
pointed at the file and reads it with its own file-reading tool, exactly like
a manual skill invocation does. A pasted copy floods the output area, burns
context twice, and goes stale the moment the file changes.

It first reads the frontmatter: `format: 2` marks a typed-grammar document;
its absence marks a legacy one (both are read and appended to normally, and
the takeover says which it saw). `summary_quality: fallback` marks a round
whose narrative was written deterministically after model validation failed
— trusted less, and reported as such.

The takeover sub-skill checks each state-and-freshness entry against:

1. the file's existence,
2. its modification timestamp versus the recorded one, and
3. in a git repo, the recorded commit SHA versus current HEAD (and the
   file's last-change SHA where practical), and
4. in a git repo with a remote, the recorded remote ref (`git ls-remote
   origin`) versus that remote — local HEAD can match the record while the
   remote has moved on, and a "pushed" claim is only true if the recorded
   SHA reached the remote.
5. every `[[Label|target]]` link in the taken-over round whose target is a
   filesystem path or URL — existence, plus the recorded mtime/SHA when
   the target also appears as a state row. A link target with no matching
   state row is an **unindexed reference**: report it as unverifiable.
6. claim structure: whether the summary is typed; each `resolved: <slug>`
   matched against an earlier `open:`/`todo:` slug in the document (an
   unmatched resolution is a finding); `open:`/`todo:` slugs closed by a
   later `resolved:` are reported as resolved.

Entries report as **verified**, **changed** (with observed mtime/SHA), or
**missing**. Changed or missing entries make the parts of the summary that
depend on them untrustworthy.

A state row that lists an untracked path (`?? some-artifact/`) is a live
claim, not a decoration: re-check `.gitignore` and `git status` for it. When
the artifact is now ignored or removed, the matching open item is resolved
and the handoff's advice about it is stale.

Additionally, regenerate the workspace snapshot with the exact command
recorded in the handoff and diff it against the recorded one. Report
**added** and **removed** paths, plus **moved** (removed + added) where the
delete/add pair is obvious. New or removed paths that the handoff's summary
does not explain are unexpected changes: surface them to the user — and if
their role in the work is ambiguous, treat them as an open follow-up under
the ask-user stop point. In a git repo, prefer `git status --short` for
new/removed detection.

## Format migration (legacy → format 2)

Checking and upgrading legacy (format 1) documents and their archives is
**metadata-only**: structure may be added around existing text; narrative
text is never rewritten, retyped, or relinked. The full contract —
detection, the mechanical fixes, the never-rewrite rules, archive
handling, and the format checklist shared with read mode — lives in
[references/format-migration.md](references/format-migration.md); findings
classify as **mechanical** (fixable by migration) or **advisory** (report
only, fix in a new round).

## Content rules (both sides)

- Do not duplicate content already captured in other artifacts (specs, plans,
  ADRs, issues, commits, diffs). Reference them as wikilinks per *Artifact
  links*, and mirror every linked filesystem target as a
  state-and-freshness row.
- Redact any sensitive information, such as API keys, passwords, or
  personally identifiable information. Takeover must not attempt to
  reconstruct redacted values.
- Only handoff mode writes to `handoff.md`; takeover mode is read-only.

## Automatic writers (companion)

An automatic round is a normal round: same document, same sections, same
merge and compaction rules. Two additions apply to it:

- The round carries a marker (`<!-- handoff-auto:<id> -->`) so re-writing the
  same session updates that round in place instead of appending a duplicate.
- A round is written only when the workspace already has a handoff, or when the
  user asked for one during the session (see *Creation policy* above).
- The narrative summary is produced by a model and is therefore validated
  before it is written. If the answer does not contain the two required
  sections, or reads like a whole document rather than a narrative, it is
  rejected and a deterministic summary (the tail of the transcript plus the
  files touched) is written instead. The state, freshness and workspace
  snapshot parts are always computed locally and never depend on the model.
  An automatic writer written against format 1 produces legacy rounds;
  those remain valid under the versioning rule in *Document structure*. An
  automatic writer that supports format 2 additionally writes the round
  marker, typed claims, and artifact links, and sets `summary_quality:
  model` in the frontmatter; the deterministic fallback sets
  `summary_quality: fallback`.