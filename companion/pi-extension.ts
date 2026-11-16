/**
 * handoff-auto — Pi extension companion to the `handoff` skill.
 *
 * Read side  (session_start): if `handoff.md` exists in the session working
 *             directory, send the takeover instruction as a user message so the
 *             agent verifies freshness, reports drift and asks the user how to
 *             proceed — without the user having to invoke /skill:handoff.
 *
 * Write side (session_shutdown): when the session ends, summarise the
 *             conversation with the session's own model and hand the narrative
 *             to the shared core, which owns the handoff file contract
 *             (state & freshness, workspace snapshot, append/merge, archive).
 *
 *             If the model call fails, the core still writes a deterministic
 *             handoff — a handoff is never lost because a summariser died.
 *
 * No runtime imports from pi packages are used on purpose: this file is loaded
 * through a symlink, and type-only imports keep it resolution-independent.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const CORE_PATH = process.env.HANDOFF_AUTO_CORE || join(homedir(), ".agents/skills/handoff/companion/core.cjs");
const LOG_PATH = process.env.HANDOFF_AUTO_LOG || join(homedir(), ".pi", "agent", "handoff-auto.log");

/**
 * Append a line to the handoff-auto log. Never throws: logging must not
 * break the host session. This is where silent failures surface — check
 * this file when a launch shows no takeover dialog.
 */
function logEvent(level: string, message: string): void {
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} [${level}] ${message}\n`);
	} catch {
		// logging must never break the session
	}
}

function safeNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "warning"): void {
	try {
		if ((ctx as { hasUI?: boolean }).hasUI === false) return;
		ctx.ui?.notify(message, level);
	} catch {
		// the log line is the record of last resort
	}
}

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
- Follow the handoff contract below; it is the source of truth for the document.
- Reference other artifacts (specs, plans, ADRs, issues, commits, diffs) by path or URL instead of duplicating them.
- Never write secrets, API keys, passwords or PII. Write [REDACTED] instead.
- Be concise and factual. Never invent facts that are not in the conversation.
- Output ONLY the two sections above. Do not write a complete handoff document: the
  state-and-freshness and workspace-snapshot sections are generated elsewhere. No
  preamble, no closing remarks, no code fences around the sections.`;

interface CoreReply {
	ok: boolean;
	error?: string;
	[key: string]: unknown;
}

interface HandoffConfig {
	handoffFile: string;
	autoTakeover: boolean;
	writeOnExit: boolean;
	takeoverSessionReasons: string[];
	writeOnExitReasons?: string[];
	maxConversationChars: number;
	pi: {
		useModelSummary: boolean;
		summaryTimeoutSec: number;
		checkpointOnSettle: boolean;
		takeoverConfirm: boolean;
		exitOffer: boolean;
		createIfMissing?: boolean;
	};
	[key: string]: unknown;
}

const DEFAULT_CONFIG: HandoffConfig = {
	handoffFile: "handoff.md",
	autoTakeover: true,
	writeOnExit: true,
	takeoverSessionReasons: ["startup"],
	writeOnExitReasons: ["quit", "new"],
	maxConversationChars: 60000,
	pi: {
		useModelSummary: true,
		summaryTimeoutSec: 120,
		checkpointOnSettle: true,
		takeoverConfirm: true,
		exitOffer: true,
		createIfMissing: false,
	},
};

const TAKEOVER_OPTIONS = [
	"Take over — verify freshness and continue",
	"Review the handoff first, don't act yet",
	"Ignore for now",
];
const EXIT_YES = "Yes — write a handoff";
const EXIT_NO = "No — exit without a handoff";
// Fresh workspace (no handoff.md yet): the safe answer comes first, so a stray
// Enter never creates a file the user did not ask for.
const EXIT_FRESH_NO = "No — exit without creating one";
const EXIT_FRESH_YES = "Yes — create a handoff for the next session";

function checkpointPath(cwd: string): string {
	const key = createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 12);
	return join(tmpdir(), `handoff-auto-${key}.json`);
}

export default function (pi: ExtensionAPI) {
	let config: HandoffConfig = DEFAULT_CONFIG;
	let pendingTakeover: { message: string; path: string } | null = null;
	let marker = "";
	// Exit-offer state. The listener must never consume keys while its own dialog is open.
	let exitPromptOpen = false;
	let suppressExitWrite = false;
	// Set when the user explicitly asked for a handoff in a workspace that had
	// none: the write is authorised even though no handoff.md exists yet.
	let authorisedWrite = false;
	let lastCtrlC = 0;
	let unsubscribeInput: (() => void) | null = null;

	/**
	 * Send the takeover as a user message. `deliverAs: "followUp"` makes the
	 * call safe in every state: an idle agent processes it immediately, a busy
	 * agent queues it for the end of the current run.
	 */
	function deliverTakeover(ctx: ExtensionContext): void {
		if (!pendingTakeover) return;
		if (!ctx.isIdle()) return;
		const takeover = pendingTakeover;
		pendingTakeover = null;
		try {
			pi.sendUserMessage(takeover.message, { deliverAs: "followUp" });
		} catch (err) {
			pendingTakeover = takeover;
			logEvent("error", `deliverTakeover failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async function core(args: string[], cwd: string, timeoutMs = 60000): Promise<CoreReply | null> {
		try {
			const result = await pi.exec("node", [CORE_PATH, ...args], { cwd, timeout: timeoutMs });
			if (result.code !== 0 && !result.stdout.trim()) {
				const message = result.stderr.trim() || `core exited ${result.code}`;
				logEvent("error", `core ${args[0]} failed: ${message}`);
				return { ok: false, error: message };
			}
			return JSON.parse(result.stdout) as CoreReply;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logEvent("error", `core ${args[0]} error: ${message}`);
			return { ok: false, error: message };
		}
	}

	async function loadConfig(cwd: string): Promise<HandoffConfig> {
		const reply = await core(["config"], cwd, 15000);
		if (reply && reply.ok && reply.config) {
			const loaded = reply.config as Partial<HandoffConfig>;
			// pi is a sub-object: merge it deeply so a config that omits a key keeps its default.
			return { ...DEFAULT_CONFIG, ...loaded, pi: { ...DEFAULT_CONFIG.pi, ...(loaded.pi || {}) } } as HandoffConfig;
		}
		if (!reply) {
			logEvent("warn", "loadConfig: core unreachable — using built-in defaults");
		} else if (!reply.ok) {
			logEvent("warn", `loadConfig: core error (${reply.error || "unknown"}) — using built-in defaults`);
		} else {
			logEvent("warn", "loadConfig: core reply carried no config — using built-in defaults");
		}
		return DEFAULT_CONFIG;
	}

	/** Does the workspace already carry a handoff document? */
	function handoffExists(cwd: string): boolean {
		const name = config.handoffFile || DEFAULT_CONFIG.handoffFile;
		try {
			return existsSync(join(cwd, name));
		} catch (err) {
			return false;
		}
	}

	/* --------------------------------------------------- transcript helpers */

	function textOf(content: unknown): string {
		if (typeof content === "string") return content.trim();
		if (!Array.isArray(content)) return "";
		return content
			.filter((part: any) => part && part.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n")
			.trim();
	}

	function branchToConversation(branch: any[]): string {
		let entries = branch;
		// A compaction invalidates everything before the first kept entry.
		let compactionIndex = -1;
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i]?.type === "compaction") {
				compactionIndex = i;
				break;
			}
		}
		if (compactionIndex >= 0) {
			const compaction = entries[compactionIndex];
			const firstKept = entries.findIndex((entry) => entry?.id === compaction.firstKeptEntryId);
			entries = [
				compaction,
				...(firstKept >= 0 ? entries.slice(firstKept, compactionIndex) : []),
				...entries.slice(compactionIndex + 1),
			];
		}

		const chunks: string[] = [];
		for (const entry of entries) {
			if (entry?.type === "compaction" && typeof entry.summary === "string") {
				chunks.push(`## Compaction summary\n\n${entry.summary}`);
				continue;
			}
			if (entry?.type !== "message") continue;
			const message = entry.message;
			if (!message) continue;
			if (message.role === "user") {
				const text = textOf(message.content);
				if (text) chunks.push(`## User\n\n${text}`);
			} else if (message.role === "assistant") {
				const text = textOf(message.content);
				if (text) chunks.push(`## Assistant\n\n${text}`);
			}
		}
		return chunks.join("\n\n");
	}

	function addCandidate(candidate: string, cwd: string, files: Set<string>): void {
		const trimmed = candidate.trim().replace(/^["']|["']$/g, "");
		if (!trimmed || trimmed.length > 400) return;
		if (trimmed.includes("*") || trimmed.includes("..")) return;
		const absolute = resolve(cwd, trimmed);
		try {
			if (existsSync(absolute) && !existsSync(join(absolute, "."))) {
				// existsSync is true for directories too; stat is avoided on purpose (cheap check).
			}
		} catch (err) {
			return;
		}
		files.add(absolute);
	}

	function extractTouchedFiles(branch: any[], cwd: string): string[] {
		const files = new Set<string>();
		for (const entry of branch) {
			if (entry?.type !== "message") continue;
			const message = entry.message;
			if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const part of message.content) {
				if (part?.type !== "toolCall") continue;
				const args = part.arguments;
				if (!args || typeof args !== "object") continue;
				for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
					if (typeof value !== "string") continue;
					if (/path|file|dir/i.test(key)) {
						for (const piece of value.split(/[\n,]+/)) addCandidate(piece, cwd, files);
					} else if (/command|cmd|script/i.test(key)) {
						let budget = 80;
						for (const token of value.split(/[\s"'`]+/)) {
							if (budget-- <= 0) break;
							if (!token.includes("/")) continue;
							addCandidate(token, cwd, files);
						}
					}
				}
			}
		}
		return [...files];
	}

	function loadCheckpoint(cwd: string): { files?: string[] } {
		try {
			const file = checkpointPath(cwd);
			if (!existsSync(file)) return {};
			return JSON.parse(readFileSync(file, "utf8")) as { files?: string[] };
		} catch (err) {
			return {};
		}
	}

	function saveCheckpoint(cwd: string, files: string[]): void {
		try {
			writeFileSync(
				checkpointPath(cwd),
				JSON.stringify({ updatedAt: new Date().toISOString(), cwd, files }, null, 2),
				"utf8",
			);
		} catch (err) {
			// A checkpoint is best-effort only.
		}
	}

	/* --------------------------------------------------------- summarisation */

	/**
	 * Ask the session model for the narrative. The raw answer is returned
	 * unchanged: the core validates it and falls back to a deterministic
	 * summary when the model ignored the format or invented a document.
	 * One repair round is allowed before giving up.
	 */
	async function summarise(
		ctx: ExtensionContext,
		conversation: string,
		files: string[],
		tmpDir: string,
	): Promise<string | null> {
		if (!ctx.model || !config.pi?.useModelSummary) return null;
		const conversationFile = join(tmpDir, "conversation.txt");
		const candidateFile = join(tmpDir, "candidate.md");
		try {
			writeFileSync(conversationFile, conversation, "utf8");
		} catch (err) {
			return null;
		}

		const promptReply = await core(
			["summary-prompt", "--cwd", ctx.cwd, "--conversation-file", conversationFile, "--files", files.join(",")],
			ctx.cwd,
			30000,
		);
		if (!promptReply || !promptReply.ok) return null;
		const systemPrompt = (promptReply.systemPrompt as string) || SUMMARY_SYSTEM_PROMPT;

		const ask = async (prompt: string): Promise<string | null> => {
			try {
				const context = {
					systemPrompt,
					messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
				};
				const response = await ctx.modelRegistry.complete(ctx.model as any, context as any, {
					signal: AbortSignal.timeout(config.pi.summaryTimeoutSec * 1000),
					cacheRetention: "none",
					sessionId: `handoff-auto-${Date.now()}`,
				} as any);
				const text = (response?.content || [])
					.filter((part: any) => part?.type === "text")
					.map((part: any) => part.text)
					.join("\n")
					.trim();
				return text || null;
			} catch (err) {
				return null;
			}
		};

		const first = await ask(promptReply.prompt as string);
		if (!first) return null;
		writeFileSync(candidateFile, first, "utf8");
		let validation = await core(["validate-summary", "--file", candidateFile], ctx.cwd, 15000);
		if (validation && !validation.accepted) {
			const repair = await core(
				["repair-prompt", "--file", candidateFile, "--reason", (validation.reason as string) || "invalid format"],
				ctx.cwd,
				15000,
			);
			if (repair && repair.ok) {
				const second = await ask(repair.prompt as string);
				if (second) {
					writeFileSync(candidateFile, second, "utf8");
					validation = await core(["validate-summary", "--file", candidateFile], ctx.cwd, 15000);
				}
			}
		}
		if (!validation || !validation.accepted) return null;
		return first === "" ? null : fs_readFile(candidateFile);
	}

	function fs_readFile(file: string): string {
		try {
			return readFileSync(file, "utf8");
		} catch (err) {
			return "";
		}
	}

	/* ------------------------------------------------------------- write side */

	async function writeHandoff(ctx: ExtensionContext, focus?: string): Promise<string | null> {
		const branch = ctx.sessionManager.getBranch() as any[];
		const conversation = branchToConversation(branch);
		let files = extractTouchedFiles(branch, ctx.cwd);
		if (files.length === 0) {
			const checkpoint = loadCheckpoint(ctx.cwd);
			files = checkpoint.files || [];
		}
		if (!conversation.trim() && files.length === 0) {
			logEvent("info", "handoff write skipped: empty conversation and no touched files");
			return null;
		}

		const tmp = mkdtempSync(join(tmpdir(), "handoff-auto-"));
		const summaryFile = join(tmp, "summary.md");
		const conversationFile = join(tmp, "conversation.txt");
		try {
			const summarised = await summarise(ctx, conversation, files, tmp);
			writeFileSync(conversationFile, conversation, "utf8");
			if (summarised) writeFileSync(summaryFile, summarised, "utf8");
			const args = [
				"write",
				"--cwd",
				ctx.cwd,
				"--agent",
				"pi",
				"--model",
				ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
				"--marker",
				marker,
				"--conversation-file",
				conversationFile,
			];
			if (summarised) args.push("--summary-file", summaryFile);
			if (focus) args.push("--focus", focus);
			if (files.length > 0) args.push("--files", files.join(","));

			const result = await core(args, ctx.cwd, 120000);
			if (!result || !result.ok) {
				logEvent("error", `handoff write failed: ${result ? result.error || "unknown core error" : "core unreachable"} (cwd=${ctx.cwd})`);
				return null;
			}
			return (result.path as string) || null;
		} finally {
			try {
				rmSync(tmp, { recursive: true, force: true });
			} catch (err) {
				// ignore
			}
		}
	}

	/* ------------------------------------------------------------ exit offer */

	async function offerExit(ctx: ExtensionContext): Promise<void> {
		exitPromptOpen = true;
		let choice: string | undefined;
		const exists = handoffExists(ctx.cwd);
		try {
			if (exists) {
				choice = await ctx.ui.select("Write a handoff for the next session?", [EXIT_YES, EXIT_NO]);
			} else {
				// No handoff in this workspace: creating one is the user's call.
				choice = await ctx.ui.select("No handoff.md in this workspace — create one for the next session?", [
					EXIT_FRESH_NO,
					EXIT_FRESH_YES,
				]);
			}
		} finally {
			exitPromptOpen = false;
		}
		if (choice === undefined) {
			ctx.ui.notify("Exit cancelled — session kept open, no handoff written", "info");
			return;
		}
		if (exists) {
			suppressExitWrite = choice === EXIT_NO;
		} else {
			authorisedWrite = choice === EXIT_FRESH_YES;
			suppressExitWrite = !authorisedWrite;
		}
		ctx.shutdown();
	}

	/**
	 * Intercept the exit gestures (Ctrl+D on an empty editor, /quit, a second
	 * Ctrl+C within 500 ms) so the offer can be shown while the TUI is still
	 * alive: session_shutdown fires after the TUI is stopped, where dialogs hang.
	 * Every other key passes through untouched.
	 */
	function installExitOffer(ctx: ExtensionContext): void {
		unsubscribeInput?.();
		unsubscribeInput = ctx.ui.onTerminalInput((data: string) => {
			if (exitPromptOpen) return undefined;
			let exiting = false;
			if (data === "\x04") {
				exiting = ctx.ui.getEditorText() === "";
			} else if (data === "\r") {
				if (ctx.ui.getEditorText().trim() === "/quit") {
					ctx.ui.setEditorText("");
					exiting = true;
				}
			} else if (data === "\x03") {
				const now = Date.now();
				if (now - lastCtrlC < 500) {
					lastCtrlC = 0;
					exiting = true;
				} else {
					lastCtrlC = now;
				}
			}
			if (!exiting) return undefined;
			void offerExit(ctx).catch(() => undefined);
			return { consume: true };
		});
	}

	/** Deliver the takeover according to the user's choice. */
	async function chooseTakeover(ctx: ExtensionContext, message: string, path: string): Promise<void> {
		exitPromptOpen = true; // our own dialog is up: the exit listener must stay out of its way
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select("handoff.md detected — how should this session start?", TAKEOVER_OPTIONS);
		} finally {
			exitPromptOpen = false;
		}
		if (choice === TAKEOVER_OPTIONS[0]) {
			pendingTakeover = { message, path };
			ctx.ui.notify("Taking over the previous session", "info");
			deliverTakeover(ctx);
		} else if (choice === TAKEOVER_OPTIONS[1]) {
			// Review only: the agent reads the file and reports a short digest.
			// The document is never pasted into the conversation.
			ctx.ui.notify("Reviewing the handoff — no action taken", "info");
			pi.sendUserMessage(
				`A handoff document from a previous session exists at ${path}. Read it yourself and give me a brief summary of the most recent round: ` +
					`what was decided, what was done, what is still open, what comes next. ` +
					`Do not verify freshness, do not run commands, and do not start any work. ` +
					`Keep the summary short — do not paste the document back to me.`,
				{ deliverAs: "followUp" },
			);
		} else {
			ctx.ui.notify("handoff.md ignored for this session", "info");
		}
	}

	/* ------------------------------------------------------------ lifecycle */

	pi.on("session_start", async (event, ctx) => {
		config = await loadConfig(ctx.cwd);
		marker = `pi:${Date.now().toString(36)}`;
		suppressExitWrite = false;
		authorisedWrite = false;

		if (ctx.mode === "tui" && config.pi.exitOffer && config.writeOnExit) installExitOffer(ctx);
		if (!config.autoTakeover) {
			logEvent("info", "takeover skipped: autoTakeover disabled in config");
			return;
		}
		if (!config.takeoverSessionReasons.includes(event.reason)) {
			logEvent("info", `takeover skipped: reason=${event.reason} not in [${config.takeoverSessionReasons.join(",")}]`);
			return;
		}

		const reply = await core(["takeover", "--cwd", ctx.cwd], ctx.cwd, 20000);
		if (!reply) {
			logEvent("error", `takeover check failed: core unreachable (cwd=${ctx.cwd})`);
			safeNotify(ctx, "handoff-auto: takeover check failed — see ~/.pi/agent/handoff-auto.log");
			return;
		}
		if (!reply.ok) {
			logEvent("error", `takeover check failed: ${reply.error || "unknown core error"} (cwd=${ctx.cwd})`);
			safeNotify(ctx, `handoff-auto: takeover check failed (${reply.error || "unknown"}) — see ~/.pi/agent/handoff-auto.log`);
			return;
		}
		if (!reply.found) {
			logEvent("info", `takeover: no takeover offered (cwd=${ctx.cwd}, reason=${(reply as { reason?: string }).reason || "unknown"}, path=${(reply.path as string) || "n/a"})`);
			return;
		}
		logEvent("info", `takeover: found ${reply.path as string} (${(reply.sectionCount as number) ?? "?"} rounds)`);

		const message = reply.message as string;
		const path = reply.path as string;
		// Only an interactive session can afford a takeover turn of its own: in
		// print/json mode the run belongs to the caller's prompt, so the
		// takeover rides along as a prompt guideline instead.
		if (ctx.mode !== "tui") {
			pendingTakeover = { message, path };
			return;
		}		if (config.pi.takeoverConfirm) {
			await chooseTakeover(ctx, message, path);
		} else {
			pendingTakeover = { message, path };
			ctx.ui.notify("handoff.md detected — taking over the previous session", "info");
			deliverTakeover(ctx);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!pendingTakeover) return;
		if (ctx.mode === "tui") return;
		const { message, path } = pendingTakeover;
		pendingTakeover = null;
		const guidelines = event.systemPromptOptions?.promptGuidelines;
		if (Array.isArray(guidelines)) {
			guidelines.push(
				`Handoff takeover: a handoff document from a previous session exists at ${path}. ` +
					`Read it and follow the handoff skill's read (takeover) mode before anything else: ` +
					`verify the state-and-freshness entries, detect workspace drift, summarise the decisions, ` +
					`work and open follow-ups, and ask the user how to proceed before starting any unfinished work. ` +
					`Do not modify the handoff file, and report a short summary instead of pasting it back. ` +
					`The takeover instruction is: ${message.slice(0, 1200)}`,
			);
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (pendingTakeover && ctx.mode === "tui") deliverTakeover(ctx);
		if (!config.pi?.checkpointOnSettle) return;
		try {
			const branch = ctx.sessionManager.getBranch() as any[];
			saveCheckpoint(ctx.cwd, extractTouchedFiles(branch, ctx.cwd));
		} catch (err) {
			// Best effort.
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		unsubscribeInput?.();
		unsubscribeInput = null;
		const reasons = config.writeOnExitReasons || ["quit", "new"];
		if (!config.writeOnExit) {
			logEvent("info", "exit write skipped: writeOnExit disabled");
			return;
		}

		const authorised = authorisedWrite;
		authorisedWrite = false;
		if (suppressExitWrite) {
			suppressExitWrite = false;
			return;
		}

		// Creation policy: a handoff document is created only when the user asked
		// for one. A workspace that already carries a handoff keeps the cycle
		// going; a workspace without one gets nothing unless the user confirmed
		// in the exit offer (or config.pi.createIfMissing is on).
		const exists = handoffExists(ctx.cwd);
		const mayCreate = config.pi?.createIfMissing === true;
		if (!exists && !authorised && !mayCreate) {
			logEvent("info", `exit write skipped: no handoff.md in ${ctx.cwd} and creation not authorised (reason=${event.reason})`);
			return;
		}
		// The reason filter only guards the automatic path: an explicit "yes" in
		// the exit offer writes no matter how the session ends.
		if (!authorised && !reasons.includes(event.reason)) {
			logEvent("info", `exit write skipped: reason=${event.reason} not in [${reasons.join(",")}]`);
			return;
		}

		try {
			const written = await writeHandoff(ctx);
			if (written && ctx.hasUI) {
				try {
					ctx.ui.notify(`handoff written: ${written}`, "info");
				} catch (err) {
					// ignore
				}
			}
		} catch (err) {
			logEvent("error", `session_shutdown handoff failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	pi.registerCommand("handoff-now", {
		description: "Write a handoff for the next session right now (same format as the automatic exit handoff)",
		handler: async (_args, ctx) => {
			try {
				const written = await writeHandoff(ctx, "manual /handoff-now");
				if (written) ctx.ui.notify(`handoff written: ${written}`, "info");
				else ctx.ui.notify("nothing to hand off (no conversation or files recorded)", "warning");
			} catch (err) {
				ctx.ui.notify(`handoff failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
