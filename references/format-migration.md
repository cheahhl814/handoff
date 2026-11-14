# Format migration (legacy → format 2)

Checking and upgrading old handoff documents — and their archives — is
**metadata-only by design**: migration adds structure around existing text
and never rewrites, retypes, or relinks narrative content.

## Detection

- frontmatter `format: 2` → current-format document.
- no frontmatter → legacy (format 1) document.
- frontmatter present but sections lacking round markers or typed claims →
  still report per-section findings.

## Mechanical fixes (only after ask-user confirmation)

- Add or refresh the document frontmatter — `type: handoff`, `format: 2`,
  plus the generated fields computable from the existing rounds: section
  count for `rounds`; latest `agent`/`model`/`written` from round headings
  and header bullets; live slug count for `open_items`. Omit any field that
  cannot be computed exactly.
- Insert a `<!-- round: ... -->` marker under each round heading, with
  `agent`/`model`/`written` derived from that round's own header bullets —
  only where the metadata is present and unambiguous in the round itself.
- Set `redacted: true` only when redaction placeholders are actually
  present; otherwise omit the field.

## What migration must never do

- Convert legacy prose summaries into typed claims — a legacy round's prose
  stays prose; the takeover already reads it with lower confidence.
- Rewrite or remove paths in prose, or add wikilinks to older sections —
  wikilinks are a writer-and-reader duty, not a backfill.
- Touch the narrative text of older sections in any way. A user-approved
  content refactor is recorded as a `note:` claim in a NEW round, never as
  an edit of history.

## Archives

`handoff-archive.md` sections are verbatim history and are **check-only by
default**. The user may explicitly confirm applying the same mechanical
fixes to an archive file; anything beyond that stays untouched.

## Format checklist (shared with read mode)

Findings classify as **mechanical** (fixable by migration) or **advisory**
(report only — fix in a new round or with explicit confirmation).

- frontmatter present with `format: 2`; generated fields match the
  document (`rounds` = section count, `open_items` = live slugs).
- every round heading is followed by a parseable round marker.
- claim headings use only the closed type set; `open:`/`todo:` headings
  carry slugs; slugs are unique across the document.
- every `resolved: <slug>` matches an earlier `open:`/`todo:` slug.
- every filesystem/URL `[[Label|target]]` exists and has a
  state-and-freshness row in the same round; targets are absolute.
- every target-less `[[slug]]` matches a claim slug.
- dates are absolute; timestamps are ISO-8601 UTC.
