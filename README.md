# handoff

Session handoff between agent sessions — one skill, three modes operating on
the same file contract. Harness-agnostic and format-versioned.

- **Write mode** — compacts the current conversation into a handoff document
  a fresh agent can pick up.
- **Read mode (takeover)** — reads an existing handoff, verifies its
  state-and-freshness entries (mtimes, commit SHAs, remote refs, workspace
  snapshot drift), and confirms open follow-ups with the user before
  proceeding.
- **Migration mode** — checks legacy handoff files (and their archives)
  against the current format contract and upgrades what is safe.

## Round format (format 2)

A handoff document is one YAML frontmatter block followed by append-only
update sections. Each round carries:

- a round marker comment (`agent` / `model` / `written`),
- a **state-and-freshness** table with recorded timestamps, SHAs, and
  remotes — the takeover verifies every row,
- a **typed-claim summary** — `decision:` / `fact:` / `open:` / `todo:` /
  `resolved:` / `note:` sections where the heading IS the claim, with
  kebab-case slugs on open items that `resolved:` closes later,
- suggested skills and a reproducible workspace snapshot.

Artifact references are wikilinks — `[[Label|/abs/path-or-url]]` with the
filesystem target mirrored as a state row, and `[[claim-slug]]` for
in-document cross-references. Legacy (format 1) documents stay readable and
appendable; the migration mode upgrades them **metadata-only** (it never
rewrites narrative text).

The single source of truth for the document contract is
[handoff-conventions.md](handoff-conventions.md); the legacy-upgrade
contract lives in [references/format-migration.md](references/format-migration.md).

## Companion auto-bridge

The `companion/` directory ships an **optional** automatic bridge — a Pi
extension and Claude Code hooks — that detects a handoff at launch and
offers takeover (or, at exit, a next-round write) through native dialogs.
It follows the same creation policy as the manual path: a handoff document
is created only when the user asks for one. See
[companion/README.md](companion/README.md); behavior is configured via
[companion/config.json](companion/config.json) (`autoTakeover`,
`writeOnExit`).

## Layout

```text
handoff/
├── SKILL.md                  # mode procedures (contract lives in the conventions file)
├── handoff-conventions.md    # the document contract: format-2 grammar, verification targets
├── references/
│   └── format-migration.md   # legacy upgrade contract: mechanical fixes, never-rewrite rules
└── companion/                # optional auto-bridge (Pi extension + Claude Code hooks)
    ├── pi-extension.ts / core.cjs / claude-hook.cjs
    ├── config.json / README.md
    └── tests/                # PTY + hook policy regression suites
```

## Structural checks

This skill follows the AiX-BIO skill standard and passes the domain-agnostic
structural linter (tool-skill profile):

```bash
python3 ~/.agents/skills/skill-forge/bin/skill-lint.py <path-to-handoff-skill>
```

## Provenance

Originally adapted from an upstream third-party handoff skill (public
GitHub; repository not pinned here) and substantially extended in-tree with
the format-2 contract — YAML frontmatter, typed claim grammar, wikilink
artifact references — and the migration mode.
