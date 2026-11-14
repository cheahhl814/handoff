#!/usr/bin/env node
/**
 * handoff-auto core — shared logic for the automatic handoff companion.
 *
 * One implementation of the handoff file contract (handoff-conventions.md) is
 * shared by every harness adapter:
 *
 *   pi-extension.ts    → pi.sendUserMessage / pi session_shutdown
 *   claude-hook.cjs    → Claude Code SessionStart / SessionEnd hooks
 *
 * The core never talks to a model. Adapters own the model call and hand the
 * narrative back; the core owns the document: state & freshness, workspace
 * snapshot, section rendering, append/merge, and compaction into
 * handoff-archive.md.
 *
 * CLI (all commands print a single JSON object on stdout):
 *
 *   node core.cjs config
 *   node core.cjs takeover   --cwd DIR
 *   node core.cjs handoff-exists --cwd DIR [--marker ID]
 *   node core.cjs state      --cwd DIR [--files a,b,c]
 *   node core.cjs write      --cwd DIR --agent NAME [--model M] [--focus F]
 *                             [--marker ID] [--summary-file F]
 *                             [--conversation-file F] [--files a,b,c]
 *   node core.cjs transcript --path FILE
 *   node core.cjs conventions
 *   node core.cjs verify     --cwd DIR [--timeout SEC] [--model M]
 *
 * Exit code is 0 on success, 1 on error (the JSON still carries the message).
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const COMPANION_DIR = __dirname;

const DEFAULT_CONFIG = {
	/** Handoff document name, relative to the session working directory. */
	handoffFile: "handoff.md",
	/** Archive file for compacted (older) update sections. */
	archiveFile: "handoff-archive.md",
	/** Read side: detect handoff.md on session start. */
	autoTakeover: true,
	/** Write side: write a handoff when the session ends. */
	writeOnExit: true,
	/** pi session_start reasons that trigger a takeover. */
	takeoverSessionReasons: ["startup"],
	/** pi session_shutdown reasons that trigger a handoff write. */
	writeOnExitReasons: ["quit", "new"],
	/** Workspace snapshot depth. */
	snapshotDepth: 3,
	/** tree -I exclude pattern (also used to build the find fallback). */
	snapshotExcludes:
		".git|node_modules|__pycache__|.venv|venv|dist|build|.mypy_cache|.pytest_cache|.ruff_cache|target|.next|.cache|node_modules",
	/** Hard cap on snapshot lines before depth is reduced / output truncated. */
	maxSnapshotLines: 200,
	/** Compact into the archive once the document holds this many sections. */
	sectionsBeforeCompact: 3,
	/** Cap on the number of files listed in state & freshness. */
	maxStateFiles: 25,
	/** Cap on conversation characters handed to a summarizer model. */
	maxConversationChars: 60000,
	pi: {
		/** Use a nested model call for the narrative summary. */
		useModelSummary: true,
		/** Timeout for the nested summary call, seconds. */
		summaryTimeoutSec: 120,
		/** Keep a per-directory checkpoint so a killed session still leaves state. */
		checkpointOnSettle: true,
		/** Ask (native dialog) before delivering the takeover turn. */
		takeoverConfirm: true,
		/** Ask whether to write a handoff when the user quits. */
		exitOffer: true,
		/**
		 * Write a handoff at exit even when the workspace has none yet.
		 * Default false: a handoff document is created only when the user asks.
		 */
		createIfMissing: false,
	},
	claude: {
		/**
		 * "verify"  → headless `claude -p` verifies the handoff before the
		 *             first prompt and injects a verified brief.
		 * "inject"  → inject the raw handoff + takeover instruction (instant).
		 * "off"     → no takeover.
		 */
		takeoverMode: "verify",
		/** Tell the agent to confirm with AskUserQuestion before taking over. */
		takeoverConfirm: true,
		/** Timeout for the headless verification call, seconds. */
		verifyTimeoutSec: 90,
		/** Timeout for the headless summary call at session end, seconds. */
		writeTimeoutSec: 180,
		/** Model for the headless calls. null → Claude Code default. */
		model: null,
		/** Read-only tools the verification call may use. */
		verifyTools: ["Read", "Grep", "Glob"],
		/** SessionStart sources that trigger a takeover. */
		sessionStartSources: ["startup"],
		/** SessionEnd reasons that trigger a handoff write. */
		sessionEndReasons: ["clear", "logout", "prompt_input_exit", "other"],
		/**
		 * Write a handoff at session end even when the workspace has none yet.
		 * Default false: a handoff document is created only when the user asks.
		 */
		createIfMissing: false,
		/** Tell the agent how to offer a handoff when the workspace has none. */
		optInNotice: true,
	},
};

/* ------------------------------------------------------------------ config */

function deepMerge(base, patch) {
	if (!patch || typeof patch !== "object") return base;
	for (const [key, value] of Object.entries(patch)) {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			base[key] = deepMerge(base[key] && typeof base[key] === "object" ? base[key] : {}, value);
		} else {
			base[key] = value;
		}
	}
	return base;
}

function loadConfig() {
	const cfg = deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), {});
	const candidates = [process.env.HANDOFF_AUTO_CONFIG, path.join(COMPANION_DIR, "config.json")];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			if (!fs.existsSync(candidate)) continue;
			const raw = fs.readFileSync(candidate, "utf8");
			deepMerge(cfg, JSON.parse(raw));
			break;
		} catch (err) {
			// A broken config must never break the session: fall back to defaults.
		}
	}
	return cfg;
}

function skillDir(cfg) {
	return cfg.skillDir || path.join(os.homedir(), ".agents/skills/handoff");
}

function conventionsPath(cfg) {
	return cfg.conventionsPath || path.join(skillDir(cfg), "handoff-conventions.md");
}

function readConventions(cfg) {
	try {
		return fs.readFileSync(conventionsPath(cfg), "utf8");
	} catch (err) {
		return "";
	}
}

/**
 * The summariser only needs the content rules, not the whole document
 * skeleton. Handing it the full contract makes models mirror the document
 * structure and answer with a complete (often hallucinated) handoff document.
 */
function summariserRules(conventions) {
	const text = conventions || "";
	const heading = text.search(/^##\s+Content rules/im);
	if (heading >= 0) {
		const rest = text.slice(heading);
		const next = rest.slice(1).search(/^##\s+/m);
		const section = next >= 0 ? rest.slice(0, next + 1) : rest;
		return section.trim();
	}
	return text.slice(0, 2000).trim();
}

/* ------------------------------------------------------------------- paths */

function handoffPath(cwd, cfg) {
	return path.join(cwd, cfg.handoffFile);
}

function archivePath(cwd, cfg) {
	return path.join(cwd, cfg.archiveFile);
}

function writeAtomic(target, content) {
	const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, content, "utf8");
	fs.renameSync(tmp, target);
}

/* -------------------------------------------------------------- shell util */

function run(command, args, cwd, timeoutMs) {
	try {
		const res = spawnSync(command, args, {
			cwd,
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: 8 * 1024 * 1024,
			env: process.env,
		});
		if (res.error) return null;
		if (res.status !== 0) return null;
		return res.stdout ?? "";
	} catch (err) {
		return null;
	}
}

function git(cwd, args) {
	const out = run("git", args, cwd, 15000);
	return out === null ? null : out.trim();
}

/* ----------------------------------------------------------- handoff parsing */

/**
 * Split a handoff document into a header block and its `## ` update sections.
 * Sections keep their raw text so archived history stays verbatim.
 */
function parseHandoff(text) {
	const lines = (text || "").split(/\r?\n/);
	const starts = [];
	// Headings inside a fenced block are content, not document sections: the
	// deterministic summary embeds a transcript tail that carries "## User" and
	// "## Assistant" lines, and counting those would make the latest section a
	// transcript fragment and inflate the compaction count.
	let inFence = false;
	let fenceMarker = "";
	lines.forEach((line, index) => {
		const fence = line.match(/^\s*(```+|~~~+)/);
		if (fence) {
			const marker = fence[1][0];
			if (!inFence) {
				inFence = true;
				fenceMarker = marker;
			} else if (marker === fenceMarker) {
				inFence = false;
			}
			return;
		}
		if (inFence) return;
		if (/^##\s+\S/.test(line)) starts.push(index);
	});
	if (starts.length === 0) {
		return { header: (text || "").replace(/\s+$/, ""), sections: [] };
	}
	const header = lines.slice(0, starts[0]).join("\n").replace(/\s+$/, "");
	const sections = [];
	for (let i = 0; i < starts.length; i++) {
		const start = starts[i];
		const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
		const raw = lines.slice(start, end).join("\n").replace(/\s+$/, "");
		const markerMatch = raw.match(/<!--\s*handoff-auto:([^\s>]+)\s*-->/);
		sections.push({
			heading: lines[start].trim(),
			raw,
			marker: markerMatch ? markerMatch[1] : null,
		});
	}
	return { header, sections };
}

function readHandoff(cwd, cfg) {
	const file = handoffPath(cwd, cfg);
	if (!fs.existsSync(file)) return { path: file, exists: false, text: "", header: "", sections: [] };
	const text = fs.readFileSync(file, "utf8");
	const parsed = parseHandoff(text);
	return { path: file, exists: true, text, header: parsed.header, sections: parsed.sections };
}

function latestSection(parsed) {
	if (!parsed.sections || parsed.sections.length === 0) return null;
	return parsed.sections[parsed.sections.length - 1];
}

/** True when the document already holds a section written with this marker. */
function hasMarkerSection(handoff, marker) {
	if (!handoff || !handoff.exists) return false;
	return handoff.sections.some((section) => section.marker === marker);
}

/**
 * When the newest round was written, in epoch milliseconds. The rendered
 * section carries its own `- **written**: <ISO>` line, so this is the round's
 * own timestamp — not the file's mtime, which any later edit would move.
 */
function lastWrittenAt(handoff) {
	if (!handoff || !handoff.sections) return 0;
	let latest = 0;
	for (const section of handoff.sections) {
		const match = section.raw.match(/^\s*-\s*\*\*written\*\*:\s*(.+)$/m);
		if (!match) continue;
		const stamp = Date.parse(match[1].trim());
		if (!Number.isNaN(stamp) && stamp > latest) latest = stamp;
	}
	return latest;
}

/* ------------------------------------------------------------ state/snapshot */

function collectState(cwd, cfg, files) {
	const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	const isRepo = inside === "true";
	const head = isRepo ? git(cwd, ["rev-parse", "HEAD"]) : null;
	const status = isRepo ? git(cwd, ["status", "--short"]) : "";

	const seen = new Set();
	const list = [];
	for (const candidate of files || []) {
		const rel = String(candidate).trim();
		if (!rel || seen.has(rel)) continue;
		seen.add(rel);
		if (list.length >= cfg.maxStateFiles) break;
		const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
		let stat;
		try {
			stat = fs.statSync(abs);
		} catch (err) {
			continue;
		}
		if (!stat.isFile()) continue;
		const relative = path.relative(cwd, abs) || rel;
		const outside = relative.startsWith("..");
		const display = outside ? abs : relative;
		const sha = isRepo && !outside ? git(cwd, ["log", "-1", "--format=%H", "--", relative]) : null;
		list.push({
			path: display,
			mtime: stat.mtime.toISOString(),
			size: stat.size,
			sha: sha && sha.length > 0 ? sha : null,
			outside,
		});
	}
	list.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));

	return { isRepo, head: head || null, status: status || "", files: list };
}

function workspaceSnapshot(cwd, cfg) {
	const excludes = cfg.snapshotExcludes;
	let depth = Number(cfg.snapshotDepth) || 3;
	let command = "";
	let output = "";

	for (;;) {
		const treeArgs = ["-L", String(depth), "--dirsfirst", "--noreport", "-I", excludes];
		const treeOut = run("tree", treeArgs, cwd, 20000);
		if (treeOut !== null) {
			command = `tree ${treeArgs.slice(0, 4).join(" ")} -I '${excludes}'`;
			output = treeOut.replace(/\s+$/, "");
			break;
		}
		const findArgs = [".", "-maxdepth", String(depth)];
		for (const exclude of excludes.split("|")) {
			findArgs.push("-not", "-path", `*/${exclude}*`);
		}
		const findOut = run("find", findArgs, cwd, 20000);
		if (findOut === null) {
			command = "(no snapshot: tree and find unavailable)";
			output = "";
			break;
		}
		command = `find ${findArgs.join(" ")} | sort`;
		output = findOut
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.sort()
			.join("\n");
		break;
	}

	let truncated = false;
	const lines = output ? output.split("\n") : [];
	if (lines.length > cfg.maxSnapshotLines && depth > 1) {
		depth = depth - 1;
		const retry = workspaceSnapshotDepth(cwd, cfg, depth);
		command = retry.command;
		output = retry.output;
		truncated = retry.truncated;
	}
	const finalLines = output ? output.split("\n") : [];
	if (finalLines.length > cfg.maxSnapshotLines) {
		truncated = true;
		output = finalLines.slice(0, cfg.maxSnapshotLines).join("\n");
	}

	return { command, output, truncated, depth, lines: output ? output.split("\n").length : 0 };
}

function workspaceSnapshotDepth(cwd, cfg, depth) {
	const excludes = cfg.snapshotExcludes;
	const treeArgs = ["-L", String(depth), "--dirsfirst", "--noreport", "-I", excludes];
	const treeOut = run("tree", treeArgs, cwd, 20000);
	if (treeOut !== null) {
		return {
			command: `tree ${treeArgs.slice(0, 4).join(" ")} -I '${excludes}'`,
			output: treeOut.replace(/\s+$/, ""),
			truncated: false,
		};
	}
	const findArgs = [".", "-maxdepth", String(depth)];
	for (const exclude of excludes.split("|")) {
		findArgs.push("-not", "-path", `*/${exclude}*`);
	}
	const findOut = run("find", findArgs, cwd, 20000);
	if (findOut === null) return { command: "(no snapshot)", output: "", truncated: false };
	return {
		command: `find ${findArgs.join(" ")} | sort`,
		output: findOut
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.sort()
			.join("\n"),
		truncated: false,
	};
}

/* ---------------------------------------------------------------- rendering */

function renderSection(opts) {
	const { agent, model, focus, marker, utc, summaryMarkdown, state, snapshot, skills } = opts;
	const lines = [];
	lines.push(`## ${agent} — ${utc.slice(0, 10)}`);
	lines.push("");
	if (marker) lines.push(`<!-- handoff-auto:${marker} -->`);
	lines.push(`- **agent**: ${agent}${model ? ` · **model**: ${model}` : ""}`);
	lines.push(`- **written**: ${utc}`);
	if (focus) lines.push(`- **focus**: ${focus}`);
	lines.push("");
	lines.push("### State and freshness");
	lines.push("");
	if (state.isRepo) {
		lines.push(`git HEAD: \`${state.head || "unknown"}\``);
	} else {
		lines.push("git HEAD: _not a git repository_");
	}
	lines.push("");
	if (state.files.length > 0) {
		lines.push("| path | mtime (UTC) | last-change SHA |");
		lines.push("| --- | --- | --- |");
		for (const file of state.files) {
			const label = file.outside ? `${file.path} _(outside the working directory)_` : file.path;
			lines.push(`| \`${label}\` | ${file.mtime} | ${file.sha ? `\`${file.sha}\`` : "_untracked_"} |`);
		}
	} else {
		lines.push("_No files recorded as touched in this session._");
	}
	lines.push("");
	if (state.isRepo) {
		lines.push("`git status --short`:");
		lines.push("");
		lines.push("```");
		lines.push(state.status.trim() ? state.status.trim() : "(clean)");
		lines.push("```");
	} else {
		lines.push("`git status --short`: _n/a (not a git repository)_");
	}
	lines.push("");
	lines.push("### Summary of the conversation");
	lines.push("");
	lines.push(summaryMarkdown.trim() || "_No summary recorded._");
	lines.push("");
	lines.push("### Suggested skills");
	lines.push("");
	if (skills && skills.length > 0) {
		for (const skill of skills) lines.push(`- ${skill}`);
	} else {
		lines.push("- _none recorded_");
	}
	lines.push("");
	lines.push("### Workspace snapshot");
	lines.push("");
	lines.push(`$ ${snapshot.command}`);
	lines.push("");
	lines.push("```");
	lines.push(snapshot.output ? snapshot.output : "(empty)");
	lines.push("```");
	if (snapshot.truncated) {
		lines.push("");
		lines.push("_Snapshot truncated to the size cap; the recorded command above regenerates the full listing._");
	}
	return lines.join("\n");
}

/**
 * Validate and extract the narrative a summariser produced.
 *
 * The core renders the section headings itself, so a model answer is only
 * accepted when it actually contains the two required sections. A model that
 * answers with a whole (possibly hallucinated) document is rejected: the
 * caller then falls back to the deterministic summary.
 */
const SUMMARY_SYSTEM_PROMPT = `You write the narrative part of a session handoff document.

Return exactly two markdown sections, with these headings and nothing else:

### Summary of the conversation
- **decisions**: what was decided and why
- **work completed**: what actually changed or was produced
- **open questions**: anything unresolved
- **next steps**: the concrete next actions, in order

### Suggested skills
- skill-name — why the next agent should call it

Rules:
- Follow the content rules below; they are the source of truth for the document.
- Reference other artifacts (specs, plans, ADRs, issues, commits, diffs) by path or URL instead of duplicating them.
- Never write secrets, API keys, passwords or PII. Write [REDACTED] instead.
- Be concise and factual. Never invent facts that are not in the conversation.
- Output ONLY the two sections above, using the exact headings shown. Do not write a
  complete handoff document: the state-and-freshness and workspace-snapshot
  sections are generated elsewhere. No preamble, no closing remarks, no code
  fences, no alternative headings.

Example of a correct answer:

### Summary of the conversation
- **decisions**: use a single SQLite file for the cache
- **work completed**: added the cache module and its unit test
- **open questions**: eviction policy is still undecided
- **next steps**: 1) decide eviction, 2) wire the cache into the loader

### Suggested skills
- python-profiling — the cache hit rate needs measuring`;

/** Shared summariser prompt so every harness asks the model the same thing. */
function buildSummaryPrompt(opts) {
	const { rules, conversation, files } = opts;
	return [
		"## Handoff content rules",
		rules || "(rules unavailable — follow the system prompt)",
		"",
		"## Conversation to compact",
		conversation,
		"",
		"## Files touched in this session",
		files && files.length > 0
			? files.map((file) => `- ${file.path} (mtime ${file.mtime}, sha ${file.sha ?? "untracked"})`).join("\n")
			: "- (none recorded)",
		"",
		"## Task",
		"Write the two sections of the handoff summary for the next session.",
	].join("\n");
}

/** Repair prompt used when the first answer did not match the contract. */
function buildRepairPrompt(opts) {
	const { answer, reason } = opts;
	return [
		"Your previous answer was rejected and cannot be used:",
		reason,
		"",
		"Your previous answer:",
		answer,
		"",
		"Answer again, with nothing but these two sections and these exact headings:",
		"",
		"### Summary of the conversation",
		"- **decisions**: ...",
		"- **work completed**: ...",
		"- **open questions**: ...",
		"- **next steps**: ...",
		"",
		"### Suggested skills",
		"- skill-name — why",
		"",
		"No preamble, no code fences, no alternative headings, no document skeleton.",
	].join("\n");
}

function extractNarrative(text) {
	const raw = (text || "").trim();
	if (!raw) return { ok: false, reason: "empty" };
	// A full document means the model ignored the format — and possibly invented facts.
	if (/^#{1,3}\s*(state and freshness|workspace snapshot)/im.test(raw)) {
		return { ok: false, reason: "model returned a full document" };
	}
	const summaryHeading = raw.search(/###\s+Summary of the conversation/i);
	if (summaryHeading < 0) return { ok: false, reason: "no summary section" };
	const rest = raw.slice(summaryHeading).replace(/^###\s+Summary of the conversation\s*$/im, "");
	const skillsHeading = rest.search(/###\s+Suggested skills/i);
	let summary = skillsHeading >= 0 ? rest.slice(0, skillsHeading) : rest;
	let skills = [];
	if (skillsHeading >= 0) {
		const skillsText = rest.slice(skillsHeading).replace(/^###\s+Suggested skills\s*$/im, "");
		skills = skillsText
			.split("\n")
			.map((line) => line.replace(/^[-*]\s*/, "").trim())
			.filter(Boolean);
	}
	// Strip fence markers but keep the fenced content.
	summary = summary.replace(/^```[a-z]*\s*$/gim, "").trim();
	if (/^#{1,2}\s+\S/m.test(summary)) return { ok: false, reason: "summary contains document headings" };
	if (!summary) return { ok: false, reason: "empty summary section" };
	return { ok: true, summary, skills };
}

/**
 * Normalise a summariser's answer: the core renders the section headings
 * itself, so a heading (and a trailing skills section) coming from the model
 * is stripped and the skills are returned separately.
 */
function sanitizeSummary(text) {
	const body = (text || "").trim();
	if (!body) return { summary: "", skills: [] };
	const skillsHeading = body.search(/^###\s+Suggested skills\s*$/m);
	let summary = body;
	const skills = [];
	if (skillsHeading >= 0) {
		summary = body.slice(0, skillsHeading);
		for (const line of body.slice(skillsHeading).replace(/^###\s+Suggested skills\s*$/m, "").split("\n")) {
			const cleaned = line.replace(/^[-*]\s*/, "").trim();
			if (cleaned) skills.push(cleaned);
		}
	}
	summary = summary.replace(/^###\s+Summary of the conversation\s*$/m, "").trim();
	return { summary, skills };
}

function deterministicSummary(conversationText, state) {
	const tail = (conversationText || "").slice(-4000).trim();
	const files = state.files.length > 0 ? state.files.map((file) => `\`${file.path}\``).join(", ") : "none recorded";
	return [
		"_Auto-generated summary — no model summary was available for this round._",
		"",
		"**Files touched in this session**: " + files,
		"",
		"**Tail of the session transcript:**",
		"",
		"```",
		tail || "(no transcript available)",
		"```",
	].join("\n");
}

function appendArchive(cwd, cfg, archivedText) {
	const file = archivePath(cwd, cfg);
	const stamp = new Date().toISOString();
	const block = [
		`<!-- handoff-auto:archived ${stamp} -->`,
		"",
		archivedText.trim(),
	].join("\n");
	let existing = "";
	try {
		if (fs.existsSync(file)) existing = fs.readFileSync(file, "utf8").replace(/\s+$/, "");
	} catch (err) {
		existing = "";
	}
	const next = existing ? `${existing}\n\n${block}\n` : `${block}\n`;
	writeAtomic(file, next);
	return file;
}

/**
 * Insert or replace this round's section, then apply the compaction rule:
 * once the document holds `sectionsBeforeCompact` sections, the older ones move
 * verbatim into handoff-archive.md and only the most recent one stays.
 */
function upsertSection(cwd, cfg, opts) {
	const file = handoffPath(cwd, cfg);
	const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	const parsed = parseHandoff(existing);
	const state = collectState(cwd, cfg, opts.files);
	const snapshot = workspaceSnapshot(cwd, cfg);
	const sectionText = renderSection({
		agent: opts.agent,
		model: opts.model,
		focus: opts.focus,
		marker: opts.marker,
		utc: opts.utc || new Date().toISOString(),
		summaryMarkdown: opts.summaryMarkdown,
		state,
		snapshot,
		skills: opts.skills,
	});

	let sections = parsed.sections.slice();
	let header = parsed.header;
	let archived = null;

	const index = sections.findIndex((section) => opts.marker && section.marker === opts.marker);
	if (index >= 0) {
		sections[index] = { heading: sectionText.split("\n")[0].trim(), raw: sectionText, marker: opts.marker };
	} else {
		if (sections.length >= cfg.sectionsBeforeCompact && sections.length > 1) {
			const keep = sections[sections.length - 1];
			const older = sections.slice(0, sections.length - 1);
			archived = appendArchive(cwd, cfg, older.map((section) => section.raw).join("\n\n"));
			sections = [keep];
		}
		sections.push({ heading: sectionText.split("\n")[0].trim(), raw: sectionText, marker: opts.marker });
	}

	const body = sections.map((section) => section.raw).join("\n\n");
	const out = header ? `${header}\n\n${body}\n` : `${body}\n`;
	writeAtomic(file, out);

	return {
		path: file,
		sectionCount: sections.length,
		archived,
		state,
		snapshot: { command: snapshot.command, lines: snapshot.lines, truncated: snapshot.truncated },
	};
}

/* ------------------------------------------------------------- takeover side */

/**
 * The takeover instruction handed to the next agent.
 *
 * It points at the file and never inlines the document: the agent reads
 * `handoff.md` itself, exactly like the manual skill invocation does. Pasting
 * the document into the conversation floods the output area and duplicates
 * content the agent can simply read.
 */
function buildTakeoverMessage(cwd, cfg, parsed) {
	const file = handoffPath(cwd, cfg);
	const rounds = parsed.sections.map((section) => section.heading);
	return [
		`A handoff document from a previous session exists at ${file}.`,
		"",
		"Read the file yourself - it is not included in this message. Take it over now, following the handoff skill's read (takeover) mode:",
		"1. Read the file and work from the most recent update section; older sections are history only.",
		"2. Verify every state-and-freshness entry (file exists, mtime vs recorded, git SHA vs current HEAD) and report each as verified / changed / missing.",
		"3. Regenerate the workspace snapshot with the exact command recorded in the handoff and diff it against the recorded one; report added / removed / moved paths.",
		"4. Treat changed or missing entries as untrustworthy and re-check the affected claims against the actual files before acting on them.",
		"5. Summarize: decisions made, work completed, open questions, next steps.",
		"6. If the handoff records unfinished work or open questions, ask the user how to proceed (use the ask-user tool) before starting anything.",
		"7. Do not modify the handoff file, and do not attempt to reconstruct redacted values.",
		"8. Report the takeover as a short summary - do not paste the document back to the user.",
		"",
		"Rounds in the document (newest last): " + (rounds.length > 0 ? rounds.join(" | ") : "(none)"),
		"Older rounds, if any, are archived in " + archivePath(cwd, cfg) + ".",
	].join("\n");
}

/* ------------------------------------------------------- claude transcript IO */

function extractTranscriptText(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		return { text: "", files: [] };
	}
	const chunks = [];
	const files = new Set();
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let entry;
		try {
			entry = JSON.parse(trimmed);
		} catch (err) {
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "summary" || entry.type === "system") continue;
		const message = entry.message;
		if (!message) continue;
		const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
		if (!role) continue;
		const content = message.content;
		let text = "";
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			text = content
				.filter((part) => part && (part.type === "text" || typeof part.text === "string"))
				.filter((part) => part.type !== "tool_result")
				.map((part) => part.text)
				.join("\n");
			for (const part of content) {
				if (!part || part.type !== "tool_use" || !part.input) continue;
				for (const [key, value] of Object.entries(part.input)) {
					if (typeof value !== "string") continue;
					if (!/path|file|notebook/i.test(key)) continue;
					for (const piece of value.split(/[\n,]+/)) {
						const trimmedPiece = piece.trim();
						if (trimmedPiece && trimmedPiece.length < 400) files.add(trimmedPiece);
					}
				}
			}
		}
		text = (text || "").trim();
		if (!text) continue;
		chunks.push(`## ${role === "user" ? "User" : "Assistant"}\n\n${text}`);
	}
	return { text: chunks.join("\n\n"), files: [...files] };
}

/* --------------------------------------------------- headless claude helpers */

function claudeChildEnv() {
	const env = { ...process.env };
	delete env.CLAUDECODE;
	delete env.CLAUDE_CODE_SSE_PORT;
	delete env.CLAUDE_CODE_ENTRYPOINT;
	env.HANDOFF_AUTO_IN_CHILD = "1";
	return env;
}

function runClaude(prompt, opts) {
	const args = ["-p", "--output-format", "text"];
	if (opts.tools && opts.tools.length > 0) args.push("--allowedTools", opts.tools.join(","));
	else args.push("--tools", "");
	if (opts.model) args.push("--model", opts.model);
	const res = spawnSync("claude", args, {
		cwd: opts.cwd,
		encoding: "utf8",
		timeout: (opts.timeoutSec || 90) * 1000,
		maxBuffer: 16 * 1024 * 1024,
		env: claudeChildEnv(),
		input: prompt,
	});
	if (res.error) return { ok: false, error: res.error.message, text: "" };
	if (res.status !== 0) {
		return { ok: false, error: (res.stderr || `claude exited ${res.status}`).trim(), text: "" };
	}
	return { ok: true, text: (res.stdout || "").trim() };
}

/* ------------------------------------------------------------------- CLI */

function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token.startsWith("--")) {
			const key = token.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) {
				args[key] = true;
			} else {
				args[key] = next;
				i++;
			}
		} else {
			args._.push(token);
		}
	}
	return args;
}

function readFileArg(value) {
	if (!value || value === true) return "";
	try {
		return fs.readFileSync(String(value), "utf8");
	} catch (err) {
		return "";
	}
}

function listArg(value) {
	if (!value || value === true) return [];
	return String(value)
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function main(argv) {
	const command = argv[0];
	const args = parseArgs(argv.slice(1));
	const cfg = loadConfig();
	const cwd = path.resolve(args.cwd || process.cwd());

	switch (command) {
		case "config":
			return { ok: true, config: cfg, corePath: COMPANION_DIR };

		case "conventions":
			return {
				ok: true,
				conventions: readConventions(cfg),
				rules: summariserRules(readConventions(cfg)),
				path: conventionsPath(cfg),
			};

		case "takeover": {
			const handoff = readHandoff(cwd, cfg);
			const parsed = parseHandoff(handoff.text);
			if (!handoff.exists || !handoff.text.trim() || parsed.sections.length === 0) {
				return { ok: true, found: false, path: handoff.path };
			}
			return {
				ok: true,
				found: true,
				path: handoff.path,
				sectionCount: parsed.sections.length,
				latest: latestSection(parsed) ? latestSection(parsed).raw : "",
				message: buildTakeoverMessage(cwd, cfg, parsed),
			};
		}

		case "summary-prompt": {
			const rules = readFileArg(args["rules-file"]) || summariserRules(readConventions(cfg));
			const conversation = readFileArg(args["conversation-file"]);
			const state = collectState(cwd, cfg, listArg(args.files));
			return {
				ok: true,
				systemPrompt: SUMMARY_SYSTEM_PROMPT,
				prompt: buildSummaryPrompt({
					rules,
					conversation: conversation.slice(-cfg.maxConversationChars),
					files: state.files,
				}),
			};
		}

		case "validate-summary": {
			const narrative = extractNarrative(readFileArg(args.file));
			return narrative.ok
				? { ok: true, accepted: true, summary: narrative.summary, skills: narrative.skills }
				: { ok: true, accepted: false, reason: narrative.reason };
		}

		case "repair-prompt": {
			return {
				ok: true,
				prompt: buildRepairPrompt({
					answer: readFileArg(args.file),
					reason: args.reason || "the answer did not contain the two required sections",
				}),
			};
		}

		case "handoff-exists": {
			const handoff = readHandoff(cwd, cfg);
			const marker = args.marker && args.marker !== true ? String(args.marker) : null;
			const hasMarker = marker ? hasMarkerSection(handoff, marker) : null;
			return {
				ok: true,
				exists: handoff.exists,
				path: handoff.path,
				sectionCount: handoff.sections.length,
				hasMarker,
				lastWrittenAt: lastWrittenAt(handoff),
			};
		}

		case "state": {
			const state = collectState(cwd, cfg, listArg(args.files));
			const snapshot = workspaceSnapshot(cwd, cfg);
			return { ok: true, state, snapshot };
		}

		case "write": {
			const summaryFile = readFileArg(args["summary-file"]);
			const conversation = readFileArg(args["conversation-file"]);
			const state = collectState(cwd, cfg, listArg(args.files));
			const rawSummary = summaryFile.trim() ? summaryFile : "";
			const narrative = rawSummary ? extractNarrative(rawSummary) : { ok: false, reason: "no model summary" };
			const summary = narrative.ok ? narrative.summary : deterministicSummary(conversation, state);
			const skills =
				listArg(args.skills).length > 0 ? listArg(args.skills) : narrative.ok ? narrative.skills : [];
			const result = upsertSection(cwd, cfg, {
				agent: args.agent || "agent",
				model: args.model || null,
				focus: args.focus || null,
				marker: args.marker || `${args.agent || "agent"}:${randomUUID()}`,
				utc: new Date().toISOString(),
				summaryMarkdown: summary,
				skills,
				files: listArg(args.files),
			});
			return {
				ok: true,
				...result,
				summarySource: narrative.ok ? "model" : "fallback",
				summaryRejected: narrative.ok ? null : narrative.reason,
			};
		}

		case "transcript": {
			const extracted = extractTranscriptText(path.resolve(String(args.path)));
			return {
				ok: true,
				text: extracted.text.slice(-cfg.maxConversationChars),
				files: extracted.files,
			};
		}

		case "verify": {
			const handoff = readHandoff(cwd, cfg);
			const parsed = parseHandoff(handoff.text);
			if (!handoff.exists || parsed.sections.length === 0) {
				return { ok: true, found: false };
			}
			const message = buildTakeoverMessage(cwd, cfg, parsed);
			const prompt = [
				"You are the read-side of a handoff takeover. The handoff document is at the path given below - read it from disk with the Read tool, it is not inlined here.",
				"Verify that document against the working directory and produce a short takeover brief for the next agent.",
				"Check every state-and-freshness entry (existence, mtime, git SHA), regenerate the workspace snapshot with the recorded command and diff it, then report:",
				"- verified / changed / missing entries",
				"- added / removed / moved workspace paths",
				"- decisions made, work completed, open questions, next steps",
				"- the open follow-ups the next agent should ask the user about",
				"Do not modify any file. Be concise. Report the brief as text in your own words - do not paste or quote lines from the handoff document.",
				"",
				message,
			].join("\n");
			const res = runClaude(prompt, {
				cwd,
				tools: cfg.claude.verifyTools,
				model: cfg.claude.model,
				timeoutSec: cfg.claude.verifyTimeoutSec,
			});
			return { ok: true, found: true, verified: res.ok, brief: res.text, error: res.error };
		}

		default:
			return { ok: false, error: `unknown command: ${command || "(none)"}` };
	}
}

if (require.main === module) {
	const result = main(process.argv.slice(2));
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	process.exit(result && result.ok === false ? 1 : 0);
}

module.exports = {
	DEFAULT_CONFIG,
	loadConfig,
	parseHandoff,
	readHandoff,
	latestSection,
	hasMarkerSection,
	lastWrittenAt,
	collectState,
	workspaceSnapshot,
	renderSection,
	upsertSection,
	buildTakeoverMessage,
	buildSummaryPrompt,
	buildRepairPrompt,
	deterministicSummary,
	extractNarrative,
	summariserRules,
	extractTranscriptText,
	main,
};
