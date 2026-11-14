#!/usr/bin/env node
/**
 * handoff-auto — Claude Code hook companion to the `handoff` skill.
 *
 *   node handoff-auto.cjs session-start   → takeover of an existing handoff.md
 *   node handoff-auto.cjs session-end     → write a handoff for the next session
 *
 * The hook reads the Claude Code hook payload (JSON on stdin) and never fails
 * the session: every error path exits 0 without output.
 *
 * SessionStart  → returns hookSpecificOutput.additionalContext so the handoff
 *                 is in context before the first prompt. In "verify" mode a
 *                 headless `claude -p` (read-only tools) verifies freshness and
 *                 drift first and injects a verified brief.
 * SessionEnd    → summarises the transcript with a headless `claude -p` and
 *                 hands the narrative to the shared core, which owns the
 *                 handoff file contract.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const COMPANION_DIR = __dirname;
const CORE_PATH = process.env.HANDOFF_AUTO_CORE || path.join(COMPANION_DIR, "core.cjs");

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
  fences, no alternative headings.`;

function readStdin() {
	try {
		return fs.readFileSync(0, "utf8");
	} catch (err) {
		return "";
	}
}

function parseInput() {
	const raw = readStdin();
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch (err) {
		return {};
	}
}

function core(args, cwd, timeoutMs) {
	try {
		const res = spawnSync("node", [CORE_PATH, ...args], {
			cwd,
			encoding: "utf8",
			timeout: timeoutMs || 60000,
			maxBuffer: 16 * 1024 * 1024,
		});
		if (res.error || !res.stdout || !res.stdout.trim()) {
			return { ok: false, error: res.error ? res.error.message : (res.stderr || "").trim() };
		}
		return JSON.parse(res.stdout);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function loadConfig(cwd) {
	const reply = core(["config"], cwd, 15000);
	return reply && reply.ok && reply.config ? reply.config : {};
}

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
	if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
	if (opts.tools && opts.tools.length > 0) args.push("--allowedTools", opts.tools.join(","));
	else args.push("--tools", "");
	if (opts.model) args.push("--model", opts.model);
	const res = spawnSync("claude", args, {
		cwd: opts.cwd,
		encoding: "utf8",
		timeout: (opts.timeoutSec || 120) * 1000,
		maxBuffer: 16 * 1024 * 1024,
		env: claudeChildEnv(),
		input: prompt,
	});
	if (res.error) return { ok: false, text: "", error: res.error.message };
	if (res.status !== 0) return { ok: false, text: "", error: (res.stderr || `claude exited ${res.status}`).trim() };
	return { ok: true, text: (res.stdout || "").trim(), error: "" };
}

const OPT_IN_NOTICE = [
	"HANDOFF — THIS WORKSPACE HAS NO handoff.md.",
	"Nothing is written automatically when this session ends: a handoff document is created only when the user asks for one.",
	'Before the session ends (when the user says the work is done, asks you to stop, or otherwise wraps up), ask once with the AskUserQuestion tool: "Write a handoff for the next session?" with the options "Yes — write a handoff" and "No — exit without a handoff".',
	"If the user says yes, run the handoff skill (/handoff) in write mode to create handoff.md. If they say no, create nothing.",
].join("\n");

function emitSessionStart(context) {
	const payload = {
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext: context,
		},
	};
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/* ------------------------------------------------------------- session start */

function sessionStart(input) {
	const cwd = path.resolve(input.cwd || process.cwd());
	const config = loadConfig(cwd);
	const claudeConfig = config.claude || {};
	const sources = claudeConfig.sessionStartSources || ["startup"];
	if (!sources.includes(input.source)) return;

	const takeover = core(["takeover", "--cwd", cwd], cwd, 20000);
	if (!takeover || !takeover.ok) return;

	if (!takeover.found) {
		// No handoff in this workspace: nothing is written on exit unless the
		// user asks for it, and the agent is the one who can ask.
		if (config.writeOnExit === false) return;
		if ((claudeConfig.optInNotice ?? true) === false) return;
		emitSessionStart(OPT_IN_NOTICE);
		return;
	}

	if (config.autoTakeover === false) return;
	const mode = claudeConfig.takeoverMode || "verify";
	if (mode === "off") return;

	const message = takeover.message || "";
	let context = message;

	if (mode === "verify") {
		const verified = core(["verify", "--cwd", cwd], cwd, (claudeConfig.verifyTimeoutSec || 90) * 1000 + 15000);
		if (verified && verified.ok && verified.verified && verified.brief) {
			context = [
				"Verified takeover brief (freshness and workspace drift checked against the working directory):",
				"",
				verified.brief,
				"",
				"---",
				"Takeover instruction (the handoff document itself is at the path above - read it, do not expect it inlined):",
				message,
			].join("\n");
		}
	}

	if (claudeConfig.takeoverConfirm !== false) {
		// A hook cannot open a dialog: the confirmation is an instruction the agent acts on.
		context = [
			"HANDOFF TAKEOVER — CONFIRM FIRST. Before doing anything else (before answering the user's first message,",
			"before reading files or running commands), use the AskUserQuestion tool to ask how to proceed, with exactly",
			"these three options, and do not start the takeover until the user has answered:",
			"1. \"Take over — verify freshness and continue\" (recommended): follow the handoff skill's read (takeover) mode as described below.",
			"2. \"Review the handoff first, don't act yet\": read the handoff file at the path below yourself and give the user a short summary of the newest round, then stop and wait. Do not paste the document back.",
			"3. \"Ignore for now\": do nothing with the handoff and continue with the user's request; leave handoff.md untouched.",
			"",
			context,
		].join("\n");
	}

	// Claude Code caps additionalContext at 10,000 characters.
	if (context.length > 9000) context = `${context.slice(0, 9000)}\n[handoff truncated]`;
	emitSessionStart(context);
}

/* --------------------------------------------------------------- session end */

/**
 * When the session started, in epoch milliseconds. The transcript's first
 * entry carries the session timestamp; the file's birth time is the fallback.
 */
function sessionStartMs(transcriptPath) {
	try {
		const raw = fs.readFileSync(transcriptPath, "utf8");
		const first = raw.split("\n").find((line) => line.trim().startsWith("{"));
		if (first) {
			const entry = JSON.parse(first);
			const stamp = entry && entry.timestamp ? Date.parse(entry.timestamp) : NaN;
			if (!Number.isNaN(stamp)) return stamp;
		}
	} catch (err) {
		// fall through to the file's own timestamps
	}
	try {
		return fs.statSync(transcriptPath).birthtimeMs;
	} catch (err) {
		return 0;
	}
}

function sessionEnd(input) {
	const cwd = path.resolve(input.cwd || process.cwd());
	const config = loadConfig(cwd);
	const claudeConfig = config.claude || {};
	if (config.writeOnExit === false) return;
	const reasons = claudeConfig.sessionEndReasons || ["clear", "logout", "prompt_input_exit", "other"];
	if (!reasons.includes(input.reason)) return;

	const transcriptPath = input.transcript_path;
	if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

	// Creation policy: a handoff document is created only when the user asked
	// for one. A workspace that already carries a handoff keeps the cycle
	// going; a workspace without one gets nothing unless the user ran the
	// handoff skill (which writes the file itself) or config allows it.
	const marker = `claude:${input.session_id || `session-${Date.now()}`}`;
	const existsReply = core(["handoff-exists", "--cwd", cwd], cwd, 15000);
	const handoffExists = !!(existsReply && existsReply.ok && existsReply.exists);
	if (!handoffExists && claudeConfig.createIfMissing !== true) {
		process.stdout.write(
			`${JSON.stringify({
				systemMessage:
					"no handoff written: this workspace has no handoff.md and nothing was written automatically. " +
					"To leave one, run the handoff skill (/handoff) before exiting.",
			})}\n`,
		);
		return;
	}
	// A round was already written during this session (the handoff skill ran at
	// the user's request): do not add a second round for the same work. The
	// round's own `written` timestamp decides this — not the file's mtime, which
	// any later edit would move.
	if (handoffExists) {
		const startedAt = sessionStartMs(transcriptPath);
		const writtenAt = existsReply && existsReply.ok ? Number(existsReply.lastWrittenAt) || 0 : 0;
		if (startedAt && writtenAt && writtenAt > startedAt) {
			process.stdout.write(
				`${JSON.stringify({ systemMessage: "handoff already written during this session — nothing added" })}\n`,
			);
			return;
		}
	}

	const transcript = core(["transcript", "--path", transcriptPath], cwd, 30000);
	if (!transcript || !transcript.ok || !(transcript.text || "").trim()) return;
	const conversation = transcript.text;
	const touchedFiles = Array.isArray(transcript.files) ? transcript.files : [];

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-auto-"));
	try {
		const summaryFile = path.join(tmp, "summary.md");
		const conversationFile = path.join(tmp, "conversation.txt");
		fs.writeFileSync(conversationFile, conversation, "utf8");

		let accepted = "";
		if (claudeConfig.model !== false) {
			const promptReply = core(
				[
					"summary-prompt",
					"--cwd",
					cwd,
					"--conversation-file",
					conversationFile,
					"--files",
					touchedFiles.join(","),
				],
				cwd,
				30000,
			);
			if (promptReply && promptReply.ok) {
				const first = runClaude(promptReply.prompt, {
					cwd,
					systemPrompt: promptReply.systemPrompt,
					tools: [],
					model: claudeConfig.model || null,
					timeoutSec: claudeConfig.writeTimeoutSec || 180,
				});
				if (first.ok && first.text) {
					if (process.env.HANDOFF_AUTO_DEBUG === "1") {
						process.stderr.write(`handoff-auto: raw model output:\n${first.text}\n---\n`);
					}
					fs.writeFileSync(summaryFile, first.text, "utf8");
					let validation = core(["validate-summary", "--file", summaryFile], cwd, 15000);
					if (!validation || !validation.accepted) {
						// One repair round: show the rejected answer and the reason.
						const repair = core(
							["repair-prompt", "--file", summaryFile, "--reason", (validation && validation.reason) || "invalid format"],
							cwd,
							15000,
						);
						if (repair && repair.ok) {
							const second = runClaude(repair.prompt, {
								cwd,
								systemPrompt: promptReply.systemPrompt,
								tools: [],
								model: claudeConfig.model || null,
								timeoutSec: claudeConfig.writeTimeoutSec || 180,
							});
							if (second.ok && second.text) {
								fs.writeFileSync(summaryFile, second.text, "utf8");
								validation = core(["validate-summary", "--file", summaryFile], cwd, 15000);
							}
						}
					}
					if (validation && validation.accepted) accepted = fs.readFileSync(summaryFile, "utf8");
				}
			}
		}

		const args = [
			"write",
			"--cwd",
			cwd,
			"--agent",
			"claude-code",
			"--model",
			claudeConfig.model || "claude-code",
			"--marker",
			marker,
			"--conversation-file",
			conversationFile,
		];
		if (accepted) args.push("--summary-file", summaryFile);
		if (touchedFiles.length > 0) args.push("--files", touchedFiles.join(","));
		const written = core(args, cwd, 120000);
		if (written && written.ok) {
			// SessionEnd cannot prompt; tell the user what happened instead.
			process.stdout.write(`${JSON.stringify({ systemMessage: `handoff written: ${written.path}` })}\n`);
		}
		if (written && written.ok && written.summarySource === "fallback") {
			process.stderr.write(`handoff-auto: model summary rejected (${written.summaryRejected}); deterministic summary written\n`);
		}
	} finally {
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
		} catch (err) {
			// ignore
		}
	}
}

/* --------------------------------------------------------------------- main */

function main() {
	const action = process.argv[2] || "";
	// Nested guard: the headless `claude -p` children must not recurse.
	if (process.env.HANDOFF_AUTO_IN_CHILD === "1") return;
	const input = parseInput();
	// Subagents have their own context; they neither take over nor hand off.
	if (input.agent_id) return;
	try {
		if (action === "session-start") sessionStart(input);
		else if (action === "session-end") sessionEnd(input);
	} catch (err) {
		// Handoff bookkeeping must never break the session.
	}
}

main();
