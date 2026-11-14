# handoff

[![Version](https://img.shields.io/badge/version-2.0.0-blue)](#-installation)
[![Type](https://img.shields.io/badge/type-agent%20skill-blueviolet)](#-installation)
[![Built with](https://img.shields.io/badge/built%20with-skill--forge-orange)](https://github.com/cheahhl814/skill-forge)

Session handoff between agent sessions — one skill, three modes (write,
takeover, migration) operating on a single versioned document contract
(`handoff.md`). Harness-agnostic by design: any agent sharing a workspace
can read, verify, and append to the same document.

**Repository**: https://github.com/cheahhl814/handoff

> [!NOTE]
> Current version: **v2.0.0** (updated 2026-11-14).

## Contents

- [Installation](#-installation)
- [Usage](#-usage)
- [Mode overview](#-mode-overview)
- [Round format (format 2)](#round-format-format-2)
- [Companion auto-bridge](#companion-auto-bridge)
- [Update check](#-update-check)
- [Repository layout](#-repository-layout)
- [Hard guarantees](#-hard-guarantees)
- [Provenance](#provenance)

## 🚀 Installation

This is an **agent skill**, not a user-facing library. The recommended install
path is to let your AI agent import it.

**Option A — give your agent this prompt (recommended):**

```text
Enable the handoff skill from the skills directory your agent watches.
Read its SKILL.md to understand the three modes (write, takeover,
migration) and the document contract in handoff-conventions.md. Verify
with the skill-forge structural linter (tool-skill profile) that the
skill passes.
```

**Option B — manual install:**

```bash
# symlink the dev tree into your agent's skills directory,
# or copy the directory there
ln -sfn "$HOME/dev/handoff" "<agent skills directory>/handoff"
```

The skill has no runtime dependencies — the linter is the only structural
tooling, and it ships with the [skill-forge](https://github.com/cheahhl814/skill-forge)
meta-skill.

## 💡 Usage

The skill is designed to be driven by an AI agent: it asks which mode to run,
then follows the procedure in `SKILL.md` against the contract in
`handoff-conventions.md`.

### Natural-language prompts that trigger the skill

```text
write a handoff for the next session
take over from the last session's handoff
check the handoff format
upgrade the legacy handoff
pick up handoff.md and continue
```

The explicit invocation path is the `/skill:handoff [focus]` slash command;
arguments describe what the next (write) or current (takeover) session is
about.

## 🗺️ Mode overview

Every mode operates on `handoff.md` per the contract in
`handoff-conventions.md` — the single source of truth for the document.

| # | Mode | Goal | Reads | Writes |
|:--|:-----|:-----|:------|:-------|
| **1** | **Write** | Compact the current conversation into a round a fresh agent can trust | session state, workspace snapshot | `handoff.md` (append-only rounds) |
| **2** | **Takeover (read)** | Verify the previous round and confirm open follow-ups with the user | `handoff.md` (+ `handoff-archive.md` on demand) | nothing — read-only |
| **3** | **Migration** | Check legacy documents against the format-2 contract and upgrade what is safe | `handoff.md`, `handoff-archive.md` | mechanical fixes only (metadata) |

## Round format (format 2)

A handoff document is one YAML frontmatter block followed by append-only
update sections — one round per session. Each round carries:

- a round marker comment (`agent` / `model` / `written` as key-value pairs),
- a **state-and-freshness** table with recorded timestamps, commit SHAs, and
  remote refs — the takeover verifies every row (including remote-vs-local
  and untracked-artifact probes),
- a **typed-claim summary** — `decision:` / `fact:` / `open:` / `todo:` /
  `resolved:` / `note:` sections where the heading IS the claim, with
  kebab-case slugs on open items that `resolved:` closes in a later round,
- suggested skills, and a reproducible workspace snapshot whose exact
  generation command is recorded above the output.

Artifact references are wikilinks — `[[Label|/abs/path-or-url]]` with the
filesystem target mirrored as a state row, and `[[claim-slug]]` for
in-document cross-references. Legacy (format 1) documents stay readable and
appendable; the migration mode upgrades them **metadata-only** (frontmatter
and round markers; it never rewrites narrative text).

The legacy-upgrade contract lives in
[references/format-migration.md](references/format-migration.md).

## 🔄 Update check

Ships a self-update check (adapted from
[skill-forge](https://github.com/cheahhl814/skill-forge)) that compares the
deployed copy's git SHA against this repository via `git fetch` — no GitHub
API call, no extra dependencies.

```bash
python3 bin/skill-update-check.py
```

| Verdict | Exit | Meaning |
|:--------|:-----|:--------|
| `UP-TO-DATE` | 0 | Local HEAD matches origin/HEAD |
| `LOCAL-AHEAD` | 0 | Unpushed local commits; no action needed |
| `BEHIND-BY-N` | 1 | Upstream is N commits ahead → re-sync from this repo |
| `OFFLINE` | 2 | `git fetch` failed; informational only |
| `NO-ORIGIN` | 2 | No `origin` remote configured; informational only |

## Companion auto-bridge

The `companion/` directory ships an **optional** automatic bridge — a Pi
extension and Claude Code hooks — that detects a handoff at launch and
offers takeover (or, at exit, a next-round write) through native dialogs.
It follows the same creation policy as the manual path: a handoff document
is created only when the user asks for one, and the document is never pasted
into the conversation — the agent is pointed at the file and reads it with
its own tools. See
[companion/README.md](companion/README.md) for behavior, configuration
(`autoTakeover`, `writeOnExit`, per-harness keys), and the regression suites
in `companion/tests/`.

## 📁 Repository layout

```text
handoff/
├── SKILL.md                  # Master orchestrator — mode selection + procedures
├── README.md                 # This file
├── handoff-conventions.md    # The document contract (single source of truth)
├── references/
│   └── format-migration.md   # Legacy upgrade contract: fixes, never-rewrite rules, checklist
├── bin/
│   └── skill-update-check.py  # Self-update check (git-SHA diff vs origin)
└── companion/                # Optional auto-bridge (Pi extension + Claude Code hooks)
    ├── core.cjs              # Contract logic — the only code that knows the format
    ├── pi-extension.ts       # Pi adapter (session_start / session_shutdown)
    ├── claude-hook.cjs       # Claude Code adapter (SessionStart / SessionEnd)
    ├── config.json           # Tunables for both adapters
    ├── README.md             # Sub-document: behavior + configuration + tests
    └── tests/                # PTY + hook policy regression suites
```

## 🔒 Hard guarantees

- **One contract, one file** — `handoff-conventions.md` is the single source
  of truth; the skill, the companion, and both modes defer to it.
- **Never paste the document** — every reader path points at the file; the
  takeover verifies entries and reports a summary, never the body.
- **Creation policy is opt-in** — a handoff document is created only when
  the user asks for one; nothing silently seeds a workspace.
- **Metadata-only migration** — legacy documents are upgraded by adding
  structure around existing text; narrative content is never rewritten,
  retyped, or relinked.
- **Model failure never loses a round** — the companion falls back to a
  deterministic summary; state, freshness, and snapshot data are computed
  locally, never by a model.

## Provenance

Originally adapted from an upstream third-party handoff skill (public
GitHub; repository not pinned here) and substantially extended in-tree with
the format-2 contract — YAML frontmatter, typed claim grammar, wikilink
artifact references — and the migration mode. Aligned to the AiX-BIO skill
standard (v2.0.0: frontmatter contract, README, structural lint) with the
[skill-forge](https://github.com/cheahhl814/skill-forge) meta-skill linter
as the structural gate.

## License

Not yet declared — a LICENSE file will accompany the first published release.
