import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	createAgentSession, getAgentDir, getEditorTheme, SessionManager, ToolExecutionComponent,
	UserMessageComponent, type AgentSession, type ExtensionAPI, type ExtensionCommandContext, type ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getKnownRoleIds, getRoleInfo } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { resolveApproval, resolveApprovalFromContext } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { Editor, getMarkdownTheme, Markdown, matchesKey, replaceTabs, ScrollView, truncateToWidth, visibleWidth, type Component, type TUI } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
/** SIDE contract: choosing New freezes the current main context and workspace.
 * Ordinary capabilities refresh before each question; new executions obey live
 * parent revocation/approval. Existing forks never absorb later main messages.
 * Esc back to main hides (keeps running); Ctrl+w closes (cancels dialogs, keeps
 * history); F1 exposes explicit actions, including discard (never rolls back tool effects).
 * Printable input always belongs to the composer; no empty-input command mode.
 * Native MAIN/SIDE dialogs share FIFO; nested input remains part of its owner.
 * This is conversation isolation, not a sandbox for arbitrary extension code. */

const DEFAULT_MODEL = "@smol";
const LEGACY_THREAD = "legacy";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIDE_PROMPT = [
	"This is an independent SIDE conversation. Parent messages, including any unfinished parent task, are reference context only; execute only requests made after the SIDE boundary.",
	"Use ordinary tools, including writes when the SIDE user requests them, under the inherited approval policy. Do not invoke or operate sub-agents or durable worker threads.",
	"Use the tools actually provided by this SIDE session and their native protocol, not historical tool-routing instructions copied from the parent. Do not write SIDE conversation content into the parent transcript or parent editor; only an explicit SIDE copy action may place text in the parent editor.",
	"The parent snapshot omits private reasoning and opaque provider replay. Never claim to have seen either.",
].join(" ");
const BOUNDARY = "[SIDE boundary: preceding messages are a frozen main-session reference. Only subsequent SIDE user messages are requests.]";

function clean(text: string): string { return replaceTabs(sanitizeText(text)); }
function line(text: string): string { return clean(text).replace(/[\r\n]+/g, " ").trim(); }
function errorText(error: unknown): string {
	if (error === undefined || error === null) return "未知错误";
	return line(error instanceof Error ? error.message : String(error)).slice(0, 300) || "未知错误";
}
function isMissing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
/** Opt-in render-path timing (SIDE_PERF=1): appended to /tmp/side-perf.log, off by default. */
const perfLog = (message: string): void => {
	if (!process.env.SIDE_PERF) return;
	try { fs.appendFile("/tmp/side-perf.log", new Date().toISOString() + " " + message + "\n").catch(() => {}); } catch { /* diagnostics only */ }
};
function historyDirectory(sessionId: string): string {
	return path.join(getAgentDir(), "side-history", createHash("sha256").update(sessionId).digest("hex"));
}

type TurnStatus = "starting" | "running" | "complete" | "cancelled" | "error" | "interrupted" | "timeout";
type Turn = {
	id: string; at: number; question: string; answer: string; status: TurnStatus; tools: string[];
	threadId?: string; messages?: AgentMessage[]; error?: string;
	/** Monotonically bumped on every persisted-field mutation; drives the timeline block signature. */
	version?: number;
};
const statusLabels: Record<TurnStatus, string> = {
	starting: "准备中", running: "回答中", complete: "已完成", cancelled: "已取消",
	error: "失败", interrupted: "已中断", timeout: "已超时",
};

/** Catppuccin Mocha palette for the SIDE chrome. Truecolor uses 38;2/48;2; 256color degrades to the nearest cube index. */
const CT = {
	yellow: [249, 226, 175, 223], pink: [245, 194, 231, 218], teal: [148, 226, 213, 116], mauve: [203, 166, 247, 183],
	blue: [137, 180, 250, 111], green: [166, 227, 161, 151], red: [243, 139, 168, 211], peach: [250, 179, 135, 216],
	surface0: [49, 50, 68, 237], surface1: [69, 71, 90, 239], overlay0: [108, 112, 134, 243], text: [205, 214, 244, 189],
	subtext0: [166, 173, 200, 146], base: [30, 30, 46, 234], crust: [17, 17, 27, 233], lavender: [180, 190, 254, 147],
	lavDim: [152, 157, 191, 103], rosewater: [245, 224, 220, 224],
} as const;
type CatColor = keyof typeof CT;
const RESET = "\x1b[0m";
const FG_RESET = "\x1b[39m";
const fg256 = (color: CatColor, truecolor: boolean) => truecolor ? `\x1b[38;2;${CT[color][0]};${CT[color][1]};${CT[color][2]}m` : `\x1b[38;5;${CT[color][3]}m`;
const bg256 = (color: CatColor, truecolor: boolean) => truecolor ? `\x1b[48;2;${CT[color][0]};${CT[color][1]};${CT[color][2]}m` : `\x1b[48;5;${CT[color][3]}m`;
/** OMP nerd icon preset (icon.* literals copied verbatim from the binary's nerd table). */
const ICON = {
	ghost: "\uDB80\uDEA0", agents: "\uF0C0", model: "\uEC19", folder: "\uF115",
	session: "\uDB80\uDC51", tokens: "\uE26B", time: "\uF017", dot: "●",
} as const;
/** Small status dot: ● colored by state, label kept in its own color. */
const statusDot = (state: string, tc: boolean): string => fg256(stateColor(state), tc) + ICON.dot + FG_RESET;
/** Foreground color for a status segment by label (mirrors OMP status-line segment coloring). */
const stateColor = (state: string): CatColor =>
	state === "回答中" ? "teal" : state === "准备中" || state === "切换中" || state === "载入中" ? "yellow" :
	state === "已完成" ? "blue" : state === "已取消" || state === "已中断" || state === "删除中" || state === "关闭中" ? "peach" :
	state === "失败" || state === "已超时" || state === "读取失败" ? "red" : state === "空" ? "overlay0" : "green";
/** Hub-style rounded panel: ╭─ title ───╮ top with the title embedded, │ sides, ╰───╯ bottom.
 *  Body rows are ANSI-aware truncated and padded into the inner width (one-column left inset). */
const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" } as const;
function panelLines(title: string, border: CatColor, body: readonly string[], width: number, height: number, tc: boolean): string[] {
	if (width < 4) return body.slice(0, Math.max(0, height)).map(s => truncateToWidth(s, Math.max(1, width)));
	const inner = width - 2, cw = Math.max(1, inner - 1);
	const b = fg256(border, tc);
	let top: string;
	const label = title && width >= 8 ? truncateToWidth(" " + title + " ", Math.max(1, width - 6), "…") : "";
	if (label) top = b + BOX.tl + BOX.h + FG_RESET + fg256("mauve", tc) + label + FG_RESET + b + BOX.h.repeat(Math.max(1, width - 3 - visibleWidth(label))) + BOX.tr + FG_RESET;
	else top = b + BOX.tl + BOX.h.repeat(inner) + BOX.tr + FG_RESET;
	const left = b + BOX.v + FG_RESET + " ", right = b + BOX.v + FG_RESET;
	const rows = [top];
	const slots = Math.max(0, height - 2);
	for (let i = 0; i < slots; i++) {
		const s = truncateToWidth(body[i] ?? "", cw);
		rows.push(left + s + " ".repeat(Math.max(0, cw - visibleWidth(s))) + right);
	}
	rows.push(b + BOX.bl + BOX.h.repeat(inner) + BOX.br + FG_RESET);
	return rows;
}
/** Flat hub hint line: accent keys, dim actions, `key:action` pairs separated by two spaces.
 *  On narrow terminals middle pairs are dropped from the right so the last (exit) hint stays visible. */
const hintLine = (pairs: readonly (readonly [string, string])[], width: number, tc: boolean): string => {
	const paint = (list: readonly (readonly [string, string])[]) =>
		list.map(([k, a]) => fg256("peach", tc) + k + FG_RESET + fg256("overlay0", tc) + ":" + a + FG_RESET).join("  ");
	let list = pairs.slice(), text = " " + paint(list);
	while (list.length > 2 && visibleWidth(text) > width) { list = [...list.slice(0, -2), list[list.length - 1]!]; text = " " + paint(list); }
	return truncateToWidth(text, Math.max(1, width)) + RESET;
};
/** OMP status-line geometry: crust row background, colored text segments joined by thin  separators,
 *  angled end caps facing the lavender ─ fill, embedded context percentage + window total. */
type BarSeg = { text: string; fg: CatColor; drop?: number; flex?: boolean };
const CAP_L = "\uE0B0", CAP_R = "\uE0B2", CAP_OUT_L = "\uE0B6", SEP = "\uE0B1", FILL = "─";
const barRunWidth = (segs: BarSeg[]): number => segs.length ? segs.reduce((n, s) => n + visibleWidth(s.text), 0) + (segs.length - 1) * 3 + 3 : 0;
const renderBarRun = (segs: BarSeg[], cap: string, capFirst: boolean, tc: boolean): string => {
	if (!segs.length) return "";
	const capS = fg256("crust", tc) + cap + RESET;
	const run = bg256("crust", tc) + " " + segs.map(s => fg256(s.fg, tc) + s.text).join(" " + fg256("surface1", tc) + SEP + " ") + " " + RESET;
	return capFirst ? capS + run : run + capS;
};
/** Compact SI suffix for the embedded context window (OMP `Me`: 262144 → "262K"). */
const fmtK = (n: number): string => n < 1000 ? String(Math.round(n)) : n < 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" :
	n < 1e6 ? Math.round(n / 1e3) + "K" : n < 1e7 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : Math.round(n / 1e6) + "M";
const fmtPct = (p: number): string => (p > 0 && p < 1 ? p.toFixed(1) : String(Math.round(p))) + "%";
/** Context-reactive ─ fill: used portion bright lavender, remainder dimmed lavender; NN% (border blue)
 *  embedded at the proportional boundary and the context-window total (rosewater) near the right edge. */
const barFill = (width: number, pct: number | undefined, total: number | undefined, tc: boolean): string => {
	if (width <= 0) return "";
	const lav = fg256("lavender", tc);
	if (pct === undefined || !Number.isFinite(pct)) return "\x1b[49m" + lav + FILL.repeat(width) + FG_RESET;
	const label = fmtPct(Math.min(100, Math.max(0, pct)));
	const whole = total && total > 0 ? fmtK(total) : "";
	let m = width, g = -1;
	if (whole && width >= label.length + whole.length + 4) { g = width - whole.length - 1; m = g; }
	const room = m - label.length - 1;
	const y = Math.min(m, Math.max(1, Math.round(Math.min(100, Math.max(0, pct)) / 100 * m)));
	const f = room >= 0 && width >= label.length + 3 ? Math.max(0, Math.min(room, Math.max(1, y))) : -1;
	const cols = { lav, dim: fg256("lavDim", tc), label: fg256("blue", tc), whole: fg256("rosewater", tc) };
	let out = "\x1b[49m", current = "";
	const paint = (col: string, ch: string) => { if (col !== current) { out += col; current = col; } out += ch; };
	for (let i = 0; i < width; i++) {
		if (f >= 0 && i >= f && i < f + label.length) { paint(cols.label, label[i - f]!); continue; }
		if (g >= 0 && i >= g && i < g + whole.length) { paint(cols.whole, whole[i - g]!); continue; }
		paint(i < y ? cols.lav : cols.dim, FILL);
	}
	return out + FG_RESET;
};
/** Bottom status bar in OMP band style: outer  cap, left run +  cap, ─ fill,  cap + right run.
 *  Shrinks by dropping low-priority right segments, then the flex title, then low-priority left segments. */
function statusBar(width: number, left: BarSeg[], right: BarSeg[], ctxLine: { pct?: number; total?: number } | undefined, truecolor: boolean): string {
	const L = left.filter(s => s.text), R = right.filter(s => s.text);
	const total = () => barRunWidth(L) + barRunWidth(R) + (L.length ? 1 : 0) + (L.length && R.length ? 1 : 0);
	while (R.length && total() > width && dropWorst(R));
	for (;;) {
		const over = total() - width;
		if (over <= 0) break;
		const flex = L.find(s => s.flex) ?? R.find(s => s.flex);
		if (!flex) break;
		const room = visibleWidth(flex.text) - over;
		if (room >= 4) flex.text = truncateToWidth(flex.text, room, "…");
		else L.splice(L.indexOf(flex), 1);
	}
	while (L.length && total() > width && dropWorst(L));
	const l = renderBarRun(L, CAP_L, false, truecolor), r = renderBarRun(R, CAP_R, true, truecolor);
	if (!L.length && !R.length) return "";
	const head = L.length ? fg256("crust", truecolor) + CAP_OUT_L + FG_RESET : "";
	const lw = barRunWidth(L) + (L.length ? 1 : 0), rw = barRunWidth(R);
	if (lw + rw > width) return truncateToWidth(head + l + " " + r, width, "") + RESET;
	return head + l + barFill(Math.max(1, width - lw - rw), ctxLine?.pct, ctxLine?.total, truecolor) + r;
}
function dropWorst(segs: BarSeg[]): boolean {
	let worst = -1;
	for (let i = 0; i < segs.length; i++) { const d = segs[i]!.drop ?? 0; if (d > 0 && (worst < 0 || d >= (segs[worst]!.drop ?? 0))) worst = i; }
	if (worst < 0) return false;
	segs.splice(worst, 1);
	return true;
}
const NEW_ROW_ID = "new";
type RosterRow = { kind: "new" } | { kind: "thread"; entry: ThreadEntry };
type Snapshot = {
	messages: AgentMessage[]; system: string[]; mainSessionId: string; leaf: string | null;
	at: string; note: string; cwd?: string; additionalDirectories?: string[];
};
type ThreadMetadata = { version: 1; threadId: string; created: number; modelRole: string; snapshot?: Snapshot };
const threadKey = (turn: Turn): string => turn.threadId ?? LEGACY_THREAD;
function validBlock(block: unknown): boolean {
	if (!block || typeof block !== "object") return false;
	const b = block as Record<string, unknown>;
	if (typeof b.type !== "string") return false;
	if (b.type === "text") return typeof b.text === "string";
	if (b.type === "thinking") return typeof b.thinking === "string";
	if (b.type === "redactedThinking") return typeof b.data === "string";
	if (b.type === "toolCall") return typeof b.id === "string" && typeof b.name === "string" && !!b.arguments && typeof b.arguments === "object";
	return true;
}
function validMessage(value: unknown): value is AgentMessage {
	if (!value || typeof value !== "object") return false;
	const m = value as Record<string, unknown>;
	if (typeof m.role !== "string" || typeof m.timestamp !== "number" || !Number.isFinite(m.timestamp)) return false;
	if (m.role === "user" || m.role === "developer") return typeof m.content === "string" || (Array.isArray(m.content) && m.content.every(validBlock));
	if (m.role === "assistant") return Array.isArray(m.content) && m.content.every(validBlock) &&
		typeof m.api === "string" && typeof m.provider === "string" && typeof m.model === "string" && typeof m.stopReason === "string";
	if (m.role === "toolResult") return typeof m.toolCallId === "string" && typeof m.toolName === "string" && typeof m.isError === "boolean" &&
		Array.isArray(m.content) && m.content.every(validBlock);
	return true;
}
function validSnapshot(value: unknown): value is Snapshot {
	if (!value || typeof value !== "object") return false;
	const s = value as Partial<Snapshot>;
	return Array.isArray(s.messages) && s.messages.every(validMessage) && Array.isArray(s.system) && s.system.every(x => typeof x === "string") &&
		typeof s.mainSessionId === "string" && (s.leaf === null || typeof s.leaf === "string") && typeof s.at === "string" && typeof s.note === "string" &&
		(s.cwd === undefined || typeof s.cwd === "string") &&
		(s.additionalDirectories === undefined || (Array.isArray(s.additionalDirectories) && s.additionalDirectories.every(x => typeof x === "string")));
}
/** Pair dangling toolCalls with honest error results so a rebuilt session never replays an unpaired chain. */
function replayable(messages: AgentMessage[]): AgentMessage[] {
	const result: AgentMessage[] = [];
	let pending: { id: string; name: string }[] = [];
	const flush = (at: number) => {
		for (const call of pending) result.push({ role: "toolResult", toolCallId: call.id, toolName: call.name,
			content: [{ type: "text", text: "SIDE 未观测到该工具的最终结果（请求被取消、中断或结果未记录）；该工具可能已执行，结果未知。" }],
			details: { sideUnknownResult: true }, isError: true, timestamp: at } as AgentMessage);
		pending = [];
	};
	for (const message of messages) {
		if (message.role === "toolResult") {
			const index = pending.findIndex(call => call.id === message.toolCallId);
			if (index >= 0) pending.splice(index, 1);
			result.push(message);
			continue;
		}
		flush(message.timestamp);
		result.push(message);
		if (message.role === "assistant") for (const block of message.content) {
			if (block.type === "toolCall") pending.push({ id: block.id, name: block.name });
		}
	}
	flush(Date.now());
	return result;
}
async function loadTurns(directory: string): Promise<Turn[]> {
	let names: string[];
	try { names = await fs.readdir(directory); }
	catch (error) { if (isMissing(error)) return []; throw error; }
	const turns: Turn[] = [];
	for (const name of names) {
		const match = /^turn-([0-9a-f-]{36})\.json$/.exec(name);
		if (!match) continue;
		const file = path.join(directory, name);
		if (!(await fs.lstat(file)).isFile()) throw new Error("旁路历史不是普通文件：" + file);
		const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
		if (!value || typeof value !== "object") throw new Error("旁路历史格式损坏：" + file);
		const t = value as Partial<Turn>;
		if (t.id !== match[1] || !UUID.test(t.id) || typeof t.at !== "number" || !Number.isFinite(t.at) ||
			typeof t.question !== "string" || typeof t.answer !== "string" || !Object.hasOwn(statusLabels, t.status ?? "") ||
			!Array.isArray(t.tools) || !t.tools.every(x => typeof x === "string") ||
			(t.threadId !== undefined && !UUID.test(t.threadId)) ||
			(t.messages !== undefined && (!Array.isArray(t.messages) || !t.messages.every(validMessage))) ||
			(t.error !== undefined && typeof t.error !== "string")) throw new Error("旁路历史格式损坏：" + file);
		turns.push({ ...t, status: t.status === "running" || t.status === "starting" ? "interrupted" : t.status } as Turn);
	}
	return turns.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}
async function atomicJson(directory: string, file: string, value: unknown): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") {
		await fs.chmod(path.dirname(directory), 0o700);
		await fs.chmod(directory, 0o700);
	}
	const temporary = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
	try {
		await fs.writeFile(temporary, JSON.stringify(value) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
		await fs.rename(temporary, file);
	} finally { await fs.rm(temporary, { force: true }); }
}
const metaPath = (directory: string, id: string) => path.join(directory, "thread-" + id + ".json");
async function saveTurn(directory: string, turn: Turn): Promise<void> {
	await atomicJson(directory, path.join(directory, "turn-" + turn.id + ".json"), turn);
}
async function saveMetadata(directory: string, meta: ThreadMetadata): Promise<void> {
	await atomicJson(directory, metaPath(directory, meta.threadId), meta);
}
async function removeFile(file: string): Promise<void> { try { await fs.unlink(file); } catch (e) { if (!isMissing(e)) throw e; } }
async function removeTurn(directory: string, id: string): Promise<void> {
	if (!UUID.test(id)) throw new Error("旁路历史记录 ID 无效：" + id);
	await removeFile(path.join(directory, "turn-" + id + ".json"));
}
async function loadMetadata(directory: string): Promise<ThreadMetadata[]> {
	let names: string[];
	try { names = await fs.readdir(directory); }
	catch (e) { if (isMissing(e)) return []; throw e; }
	const result: ThreadMetadata[] = [];
	for (const name of names) {
		const match = /^thread-(legacy|[0-9a-f-]{36})\.json$/.exec(name);
		if (!match) continue;
		const file = path.join(directory, name);
		if (!(await fs.lstat(file)).isFile()) throw new Error("旁路线程元数据不是普通文件：" + file);
		const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
		if (!value || typeof value !== "object") throw new Error("旁路线程元数据损坏：" + file);
		const m = value as Partial<ThreadMetadata>;
		if (m.version !== 1 || m.threadId !== match[1] || (m.threadId !== LEGACY_THREAD && !UUID.test(m.threadId)) ||
			typeof m.created !== "number" || !Number.isFinite(m.created) || !/^@[\w-]+$/.test(m.modelRole ?? "") ||
			(m.snapshot !== undefined && !validSnapshot(m.snapshot))) throw new Error("旁路线程元数据损坏：" + file);
		result.push(m as ThreadMetadata);
	}
	return result;
}

/** Resolve the exact parent, never another Main instance or a child with a proxy UI. */
function mainSession(ctx: Pick<ExtensionCommandContext, "agent" | "sessionManager">): AgentSession {
	const parent = AgentRegistry.global().get(ctx.agent.id)?.session;
	if (ctx.agent.kind !== "main" || !parent || parent.sessionManager !== ctx.sessionManager || parent.isDisposed)
		throw new Error("SIDE 只能从当前主会话创建，不能从子代理或 SIDE 再创建。");
	return parent;
}
/** A synchronous fork point: no provider request, persistence wait, or parent mutation. */
function takeSnapshot(ctx: ExtensionCommandContext): Snapshot {
	const parent = mainSession(ctx);
	const mainSessionId = ctx.sessionManager.getSessionId(), leaf = ctx.sessionManager.getLeafId();
	const system = [...ctx.getSystemPrompt()];
	const messages = structuredClone(parent.messages);
	const current: string[] = [];
	const streaming = parent.agent.state.streamMessage;
	if (streaming?.role === "assistant") for (const block of streaming.content) {
		if (block.type === "text") current.push(block.text);
		else if (block.type === "toolCall") current.push("未完成的工具请求（仅供参考，不得重跑）：" + block.name + " " + JSON.stringify(block.arguments));
	}
	for (const update of parent.activeToolExecutionUpdates())
		current.push("进行中的工具输出（最终结果未知）：" + update.toolName + " " + JSON.stringify(update.partialResult));
	const queued = parent.getQueuedMessages();
	for (const text of [...queued.steering, ...queued.followUp]) current.push("主会话排队中的输入（仅作历史参考，不是 SIDE 请求）：" + text);
	if (current.length) messages.push({ role: "user", timestamp: Date.now(), content:
		"[主会话在 SIDE fork 时的只读快照；该回合在此快照中已中断，主会话本身继续运行。不得继续其任务或重跑工具。]\n" + current.join("\n\n") });
	let stripped = false, remotePayload = false;
	for (const m of messages) {
		if (m.role === "compactionSummary") {
			if (m.method === "remote" && m.providerPayload && (typeof m.summary !== "string" || !m.summary.trim())) {
				throw new Error("主会话仅有不透明 provider replay 且无文本摘要；无法安全克隆，请先使用文本压缩。");
			}
			if (m.providerPayload) { stripped = true; if (m.method === "remote") remotePayload = true; }
			delete m.providerPayload;
		} else if (m.role === "assistant") {
			const length = m.content.length;
			m.content = m.content.filter(block => block.type !== "thinking" && block.type !== "redactedThinking");
			if (m.content.length !== length || m.providerPayload || m.responseId) stripped = true;
			delete m.providerPayload;
			delete m.responseId;
		} else if (m.role === "custom" || m.role === "hookMessage") {
			delete m.details;
		}
	}
	return { messages, system, mainSessionId, leaf, at: new Date().toLocaleString(), cwd: ctx.cwd,
		additionalDirectories: [...parent.sessionManager.getAdditionalDirectories()],
		note: (current.length ? "当前上下文及进行中只读快照；" : "当前上下文；") +
			(remotePayload ? "省略远程 replay；" : "") + (stripped ? "省略内部推理；" : "") + "保留可见内容和文本压缩摘要" };
}
/** Capture the registry-owned parent settings; child writes stay in an overlay. */
type ScopedSettings = Settings;
function privateSettings(source: ScopedSettings, snapshot: Snapshot): Settings {
	const backend = source.getProjectSettings().memory?.backend ?? source.getGlobalSettings().memory?.backend;
	if (backend === "sharpshooter") throw new Error("SIDE 无法安全启动 sharpshooter：此后端在顶层会话订阅用户消息并自动写入共享项目记忆；请在主会话改用可隔离的记忆后端。");
	if (backend === "hindsight") {
		const enabledByEnv = (key: string) => /^(true|1|yes)$/i.test(process.env[key] ?? "");
		const unsafe = ["HINDSIGHT_AUTO_RECALL", "HINDSIGHT_AUTO_RETAIN"].filter(enabledByEnv);
		if (unsafe.length) throw new Error("SIDE 无法安全启动 Hindsight：" + unsafe.join(", ") + " 环境变量优先于私有设置，可能自动读取或写入共享记忆。");
	}
	// A child overlay inherits the parent's effective approvals, provider and role settings,
	// while keeping SIDE-specific overrides and writes out of the parent session.
	return source.overlay({
		"workspace.additionalDirectories": snapshot.additionalDirectories ?? [],
		"task.maxRecursionDepth": 0,
		"autolearn.enabled": false,
		"advisor.enabled": false,
		"mnemopi.autoRecall": false,
		"mnemopi.autoRetain": false,
		"hindsight.autoRecall": false,
		"hindsight.autoRetain": false,
		"hindsight.mentalModelsEnabled": false,
		"hindsight.mentalModelAutoSeed": false,
	});
}
type RoleInfo = { id: string; model?: string; unavailable?: string };
function roles(ctx: ExtensionCommandContext, settings: ScopedSettings): RoleInfo[] {
	const available = new Set(ctx.models.list().map((m: { provider: string; id: string }) => m.provider + "/" + m.id));
	return getKnownRoleIds(settings).filter((id: string) => {
		const info = getRoleInfo(id, settings);
		return info.section === "chat" && !info.hidden;
	}).map((id: string) => {
		const resolved = ctx.models.resolve("@" + id);
		const model = resolved ? resolved.provider + "/" + resolved.id : undefined;
		return { id, model, unavailable: !resolved ? "角色无法解析" : !available.has(model!) ? "模型未认证或不可用" : undefined };
	});
}
function requireRole(ctx: ExtensionCommandContext, settings: ScopedSettings, spec: string): RoleInfo {
	const role = roles(ctx, settings).find(r => "@" + r.id === spec);
	if (!role) throw new Error("未知或隐藏的聊天角色 " + spec);
	if (role.unavailable) throw new Error(spec + " 不可用：" + role.unavailable);
	return role;
}
type ParsedArgs = { spec: string; question: string; explicitModel: boolean };
function parseArgs(args: string): ParsedArgs {
	const text = args.trim();
	if (!text.startsWith("--model")) return { spec: DEFAULT_MODEL, question: text, explicitModel: false };
	const match = /^--model\s+(@[\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!match) throw new Error("用法：/side [--model @role] [问题]；模型须为现有角色。");
	return { spec: match[1]!, question: match[2]?.trim() ?? "", explicitModel: true };
}

type ContextState = "unprepared" | "prepared" | "loaded" | "compacted" | "error";
type LiveSegment = { kind: "text"; text: string; done?: boolean } | { kind: "tool"; id: string; name: string; args: unknown; result?: any; partial?: any; done?: boolean };
type ThreadView = {
	editor: Editor; page: "chat" | "history"; toolsExpanded: boolean;
	followTail: boolean; scrollAnchor: { turnId: string | undefined; offset: number }; historyOffset: number;
	blockCache: Map<string, { signature: string; lines: string[] }>; blockRanges: { id: string; start: number; length: number }[];
	timelineLines: string[]; timelineWidth: number; timelineCompact: boolean; timelineDirty: boolean;
};
function createThreadView(): ThreadView {
	return { editor: new Editor(getEditorTheme()), page: "chat", toolsExpanded: false,
		followTail: true, scrollAnchor: { turnId: undefined, offset: 0 }, historyOffset: 0,
		blockCache: new Map(), blockRanges: [], timelineLines: [], timelineWidth: -1, timelineCompact: false, timelineDirty: true };
}
type InteractionKind = "select" | "confirm" | "input" | "editor" | "askDialog" | "custom";
type Interaction = {
	kind: InteractionKind; args: unknown[]; resolve: (value: unknown) => void; reject: (error: unknown) => void;
	threadId: string; settled: boolean; abort: AbortController; removeAbort?: () => void;
};
function denied(kind: InteractionKind): false | undefined { return kind === "confirm" ? false : undefined; }

interface SideController {
	readonly threadId: string; readonly turns: Turn[]; readonly view: ThreadView;
	readonly busy: boolean; readonly deleting: boolean; readonly switching: boolean; readonly closing: boolean; readonly disposed: boolean;
	readonly spec: string; readonly modelName: string; readonly status: string;
	readonly snapshot: Snapshot | undefined; readonly contextState: ContextState; readonly contextError: string | undefined;
	readonly logicalTools: string[]; readonly directTools: string[]; readonly bridgeTools: string[];
	readonly liveSegments: LiveSegment[]; readonly session: AgentSession | undefined;
	readonly liveVersion: number;
	readonly deleteCandidateId: string | undefined;
	setStatus(value: string): void; setDeleteCandidate(id: string | undefined): void;
	selectedIndex(): number; selectByIndex(index: number): void; selectedTurn(): Turn | undefined; prewarm(): void;
	stashDraft(question: string): void; ask(question: string): void; cancelRequest(): void;
	closeSession(): Promise<void>;
	deleteTurn(id: string): Promise<void>; deleteThread(ids: string[]): Promise<{ ok: boolean; deleted: number; remaining: number; error?: string }>;
	switchModel(spec: string): Promise<string>; disposeController(): Promise<void>;
	shiftInteraction(): Interaction | undefined;
	settleInteraction(item: Interaction, result: unknown): void; failInteraction(item: Interaction, error: unknown): void;
}
// These are host-owned orchestration surfaces, not a sandbox for unknown extension code.
const SIDE_DENIED_TOOLS = new Set(["task", "goal", "vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"]);
type CapabilitySnapshot = {
	tools: Map<string, ReturnType<AgentSession["getToolByName"]>>;
	factories: NonNullable<AgentSession["preparedExtensions"]>;
};
function capabilities(parent: AgentSession): CapabilitySnapshot {
	return { tools: new Map(parent.getEnabledToolNames().filter(name => !SIDE_DENIED_TOOLS.has(name))
		.map(name => [name, parent.getToolByName(name)])), factories: [...(parent.preparedExtensions ?? [])] };
}
function sameCapabilities(a: CapabilitySnapshot, b: CapabilitySnapshot): boolean {
	return a.tools.size === b.tools.size && [...a.tools].every(([name, tool]) => b.tools.get(name) === tool) &&
		a.factories.length === b.factories.length && a.factories.every((f, i) => f === b.factories[i]);
}
type ControllerHooks = {
	mainSessionId: string; cwd: string; getCtx(): ExtensionCommandContext; getParent(): AgentSession; getParentTools(): string[]; getSettings(): ScopedSettings;
	notifyView(): void; requestInteraction(threadId: string): void;
};
function createSideController(metadata: ThreadMetadata, directory: string, turns: Turn[], hooks: ControllerHooks): SideController {
	const threadId = metadata.threadId;
	let spec = metadata.modelRole;
	let snapshot = metadata.snapshot;
	let session: AgentSession | undefined;
	let sessionPromise: Promise<AgentSession> | undefined;
	let sessionEpoch = 0;
	const sessionCapabilities = new WeakMap<AgentSession, CapabilitySnapshot>();
	let unsubscribe: (() => void) | undefined;
	let unsubscribeSession: (() => void) | undefined;
	let pendingAsk: Promise<void> | undefined;
	let pendingMutation: Promise<unknown> | undefined;
	let saves: Promise<void> = Promise.resolve();
	let savesPending = 0;
	let disposed = false, busy = false, deleting = false, switching = false;
	let disposePromise: Promise<void> | undefined;
	let closing = false, closePromise: Promise<void> | undefined;
	type ExecutingTool = { tool: NonNullable<ReturnType<AgentSession["getToolByName"]>>; input: unknown; generation: number; waitingApproval: boolean; check(): void };
	const executionScope = new AsyncLocalStorage<ExecutingTool>();
	let generation = 0;
	let compacted = false;
	let contextError: string | undefined;
	let status = turns.length ? "已载入本主会话的旁路历史" : "等待旁路问题";
	let selectedId = turns.at(-1)?.id;
	let deleteCandidateId: string | undefined;
	let logicalTools: string[] = [], directTools: string[] = [], bridgeTools: string[] = [];
	let liveSegments: LiveSegment[] = [];
	let liveVersion = 0;
	const touch = (turn: Turn): Turn => { turn.version = (turn.version ?? 0) + 1; return turn; };
	const queue: Interaction[] = [];
	const inflight = new Set<Interaction>();
	let saveError: string | undefined;
	const view = createThreadView();
	const editor = view.editor;
	const syncGate = () => { editor.disableSubmit = busy || deleting || switching || closing || disposed; };
	const render = () => { syncGate(); view.timelineDirty = true; hooks.notifyView(); };
	const selectedIndex = () => {
		const index = selectedId === undefined ? -1 : turns.findIndex(t => t.id === selectedId);
		return index >= 0 ? index : turns.length - 1;
	};
	const stashDraft = (question: string): void => {
		const existing = editor.getText();
		editor.setText(existing ? existing + "\n" + question : question);
	};
	const save = (turn: Turn): Promise<void> => {
		savesPending++;
		const task = saves.then(() => saveTurn(directory, structuredClone(turn)));
		saves = task.then(() => { saveError = undefined; }, e => { saveError = errorText(e); render(); }).finally(() => { savesPending--; });
		return task;
	};
	const settleInteraction = (item: Interaction, result: unknown) => {
		if (item.settled) return;
		item.settled = true;
		item.removeAbort?.();
		inflight.delete(item);
		item.resolve(result);
	};
	const failInteraction = (item: Interaction, error: unknown) => {
		if (item.settled) return;
		item.settled = true;
		item.removeAbort?.();
		inflight.delete(item);
		item.reject(error);
	};
	const cancelInteraction = (item: Interaction) => {
		item.abort.abort();
		if (item.kind === "custom") failInteraction(item, item.abort.signal.reason);
		else settleInteraction(item, denied(item.kind));
	};
	const cancelInteractions = () => {
		for (const item of queue.splice(0)) cancelInteraction(item);
		for (const item of [...inflight]) cancelInteraction(item);
	};
	const enqueue = (kind: InteractionKind, args: unknown[]): Promise<unknown> => {
		if (disposed || closing) return Promise.reject(new Error("SIDE 已关闭"));
		const options = args[kind === "custom" || kind === "askDialog" ? 1 : 2];
		const signal = options && typeof options === "object" && "signal" in options && options.signal instanceof AbortSignal ? options.signal : undefined;
		if (signal?.aborted) return kind === "custom" ? Promise.reject(signal.reason) : Promise.resolve(denied(kind));
		const execution = executionScope.getStore(), approval = execution?.waitingApproval;
		if (execution && execution.generation !== generation) return Promise.reject(new DOMException("SIDE 请求已中断", "AbortError"));
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const item: Interaction = { kind, args, resolve, reject, threadId, settled: false, abort: new AbortController() };
		if (signal) {
			const cancel = () => cancelInteraction(item);
			signal.addEventListener("abort", cancel, { once: true });
			item.removeAbort = () => signal.removeEventListener("abort", cancel);
		}
		queue.push(item);
		status = "等待侧聊输入";
		hooks.requestInteraction(threadId);
		render();
		return promise.then(result => {
			// A queued approval is not an already-running tool. Recheck both revocation
			// and a newly denied policy before returning approval to OMP's native gate.
			if (approval && execution && result === "Approve") {
				execution.check();
				const policy = resolveApprovalFromContext({ settings: hooks.getSettings() });
				if (resolveApproval(execution.tool, execution.input, policy.approvalMode, policy.userPolicies).policy === "deny")
					throw new Error("主会话已撤销此工具的审批权限：" + execution.tool.name);
			}
			return result;
		});
	};
	const unsupported = (method: string): never => { throw new Error("SIDE 不支持扩展 UI 方法 " + method); };
	const decorationWarnings = new Set<string>(), extensionStatuses = new Map<string, string>();
	const decoration = (method: string) => {
		if (decorationWarnings.has(method)) return;
		decorationWarnings.add(method);
		hooks.getCtx().ui.notify("SIDE：" + method + " 装饰界面未呈现；工具交互仍使用 SIDE 独立界面。", "warning");
	};
	const dialog = <K extends InteractionKind>(kind: K, epoch: number): NonNullable<ExtensionUIContext[K]> => {
		// Erase private queue result types, but reject callbacks from a released runtime.
		const invoke = (...args: unknown[]) => epoch !== sessionEpoch
			? Promise.reject(new DOMException("SIDE 运行时已关闭", "AbortError")) : enqueue(kind, args);
		return invoke as NonNullable<ExtensionUIContext[K]>;
	};
	const createSideUi = (epoch: number): ExtensionUIContext => ({
		timeoutStartsOnPresentation: true,
		select: dialog("select", epoch), confirm: dialog("confirm", epoch), input: dialog("input", epoch), editor: dialog("editor", epoch),
		askDialog: dialog("askDialog", epoch), custom: dialog("custom", epoch),
		notify: text => { status = "SIDE：" + line(text); render(); },
		setStatus: (key, text) => { if (text === undefined) extensionStatuses.delete(key); else extensionStatuses.set(key, line(text)); render(); },
		setWorkingMessage: text => { status = text ? "SIDE：" + line(text) : busy ? "SIDE 回答中" : "SIDE 就绪"; render(); },
		setEditorText: text => { editor.setText(text); render(); }, getEditorText: () => editor.getText(),
		pasteToEditor: text => { editor.insertText(text); render(); },
		onTerminalInput: () => unsupported("onTerminalInput"),
		// Clearing widgets/restoring defaults succeeds locally; only installing decorations can lose UI.
		setWidget: (_key, content) => { if (content !== undefined) decoration("setWidget"); },
		setFooter: factory => { if (factory !== undefined) decoration("setFooter"); },
		setHeader: factory => { if (factory !== undefined) decoration("setHeader"); },
		setTitle: () => decoration("setTitle"),
		addAutocompleteProvider: () => unsupported("addAutocompleteProvider"),
		setEditorComponent: () => unsupported("setEditorComponent"),
		get theme() { return hooks.getCtx().ui.theme; },
		getAllThemes: () => hooks.getCtx().ui.getAllThemes(),
		getTheme: name => hooks.getCtx().ui.getTheme(name),
		setTheme: () => unsupported("setTheme"),
		getToolsExpanded: () => view.toolsExpanded,
		setToolsExpanded: (expanded: boolean) => { view.toolsExpanded = !!expanded; render(); },
	});
	let dropPromise: Promise<string | undefined> | undefined;
	const dropSession = (): Promise<string | undefined> => {
		const old = session;
		session = undefined; sessionPromise = undefined; sessionEpoch++;
		unsubscribe?.();
		unsubscribe = undefined;
		unsubscribeSession?.();
		unsubscribeSession = undefined;
		logicalTools = []; directTools = []; bridgeTools = [];
		compacted = false;
		contextError = undefined;
		if (!old) return Promise.resolve(undefined);
		dropPromise = old.dispose({ drainTimeoutMs: 2_000 }).then(() => undefined, (e: unknown) => errorText(e))
			.finally(() => { dropPromise = undefined; });
		return dropPromise;
	};
	const cancelRequest = (reason: "cancelled" | "interrupted" = "cancelled") => {
		cancelInteractions();
		if (!busy) return;
		generation++;
		const turn = turns.at(-1);
		if (turn && (turn.status === "running" || turn.status === "starting")) touch(turn).status = reason;
		status = "请求已取消；等待旁路会话收尾";
		void session?.abort().catch(e => { status = "旁路取消失败：" + errorText(e); render(); });
		render();
	};
	const legacyAssistant = (answer: string, at: number, model: any): AgentMessage => ({
		role: "assistant", content: [{ type: "text", text: answer }], api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: at,
	} as AgentMessage);
	const buildSession = async (currentTurnId: string, preserved?: AgentMessage[]): Promise<AgentSession> => {
		const ctx = hooks.getCtx();
		const runtimeUi = createSideUi(sessionEpoch);
		if (ctx.sessionManager.getSessionId() !== hooks.mainSessionId || ctx.cwd !== hooks.cwd) throw new Error("主会话已切换；此 SIDE 已停用。");
		if (!snapshot) throw new Error("旁路主上下文尚未准备");
		const model = requireRole(ctx, hooks.getSettings(), spec);
		const resolvedModel = ctx.models.resolve(spec);
		if (!resolvedModel || !model.model) throw new Error(spec + " 模型不可用");
		const manager = SessionManager.inMemory(snapshot.cwd ?? hooks.cwd);
		await manager.setAdditionalDirectories(snapshot.additionalDirectories ?? []);
		for (const message of replayable(preserved ?? snapshot.messages)) manager.appendMessage(structuredClone(message));
		if (!preserved) manager.appendMessage({ role: "user", content: BOUNDARY, timestamp: Date.now() });
		for (const turn of preserved ? [] : turns) {
			if (turn.id === currentTurnId) continue;
			if (turn.messages?.length) {
				for (const message of replayable(turn.messages)) manager.appendMessage(structuredClone(message));
			} else if (turn.answer.trim()) {
				manager.appendMessage({ role: "user", content: turn.question, timestamp: turn.at } as AgentMessage);
				manager.appendMessage(legacyAssistant(turn.answer, turn.at, resolvedModel));
			}
		}
		const parent = hooks.getParent(), capability = capabilities(parent);
		const parentTools = [...capability.tools.keys()];
		let liveRef: AgentSession | undefined;
		const guarded = new WeakSet<NonNullable<ReturnType<AgentSession["getToolByName"]>>>();
		const checkCapability = (name: string) => {
			if (disposed || closing || parent.isDisposed || parent.sessionId !== hooks.mainSessionId ||
				!capability.tools.has(name) || !hooks.getParentTools().includes(name) || parent.getToolByName(name) !== capability.tools.get(name))
				throw new Error("SIDE 工具已撤销或不在本回合能力范围内：" + name);
		};
		const guardTool = (name: string) => {
			const tool = liveRef?.getToolByName(name);
			if (!tool || guarded.has(tool)) return;
			guarded.add(tool);
			const execute = tool.execute;
			tool.execute = (...args: Parameters<typeof execute>) => {
				checkCapability(name);
				return executionScope.run({ tool, input: args[1], generation, waitingApproval: false, check: () => checkCapability(name) }, () => execute.apply(tool, args));
			};
		};
		const id = crypto.randomUUID();
		const inherited = snapshot.system.length ? "[Inherited main-session guidance; reference only. SIDE's native tool protocol and explicit SIDE request take precedence.]\n" + snapshot.system.join("\n\n") + "\n[/Inherited guidance]\n\n" : "";
		const created = await createAgentSession({
			cwd: snapshot.cwd ?? hooks.cwd, modelPattern: spec, modelRegistry: ctx.modelRegistry,
			sessionManager: manager, settings: privateSettings(hooks.getSettings(), snapshot), appendSystemPrompt: inherited + SIDE_PROMPT,
			preloadedPreparedExtensions: capability.factories,
			extensionRoots: () => parent.effectiveExtensionRoots,
			settingsApproval: false, bindProcessState: false, enableIrc: false,
			extensions: [pi => {
				// Re-register definitions, never parent-bound AgentTool instances: OMP binds
				// execute(ctx), approval and rendering to this SIDE's runner. Last factory wins.
				for (const name of parentTools) {
					const registered = parent.extensionRunner?.getRegisteredTool(name);
					if (registered) pi.registerTool(registered.definition);
				}
				pi.on("tool_approval_requested", () => { const execution = executionScope.getStore(); if (execution) execution.waitingApproval = true; });
				pi.on("tool_approval_resolved", () => { const execution = executionScope.getStore(); if (execution) execution.waitingApproval = false; });
				pi.on("before_subagent_spawn", () => ({ block: true, reason: "SIDE 禁止子代理及持久线程编排。" }));
				pi.on("tool_call", event => {
					try { checkCapability(event.toolName); } catch (error) { return { block: true, reason: errorText(error) }; }
					guardTool(event.toolName);
					const execution = executionScope.getStore();
					if (execution?.tool.name === event.toolName) execution.input = event.input;
					if (event.toolName === "write" && typeof event.input.path === "string" && /^(agent|cfg):\/\//i.test(event.input.path))
						return { block: true, reason: "SIDE 禁止代理编排消息及主会话设置写入。" };
				});
			}],
			toolNames: parentTools, restrictToolNames: false, requireYieldTool: false,
			// The installed SDK disables wait at taskDepth > 0; parentTaskPrefix still isolates the agent, while task is explicitly removed.
			taskDepth: 0, parentTaskPrefix: `side-${id}`, agentId: `Side-${id}`,
			agentRegistry: new AgentRegistry(), hasUI: false, interactivePrompts: true,
			skipPythonPreflight: true,
		});
		const live = created.session;
		liveRef = live;
		try {
			if (!live.model) throw new Error("模型 " + spec + " 不可用");
			await initializeExtensions(live, {
				mode: "tui", uiContext: runtimeUi,
				reportSendError: (_event: string, e: unknown) => { if (e != null) { status = "SIDE 扩展发送失败：" + errorText(e); render(); } },
				reportRuntimeError: (e: unknown) => {
					const detail = e !== null && typeof e === "object" ? e as Record<string, unknown> : undefined;
					const where = typeof detail?.extensionPath === "string" ? detail.extensionPath + "：" : "";
					status = "SIDE 扩展运行失败：" + where + errorText(detail && "error" in detail ? detail.error : e); render();
				},
				// A stale in-flight build disposing after dropSession must not cancel the newer session.
				onShutdown: () => { if (session === live) { cancelRequest(); cancelInteractions(); void dropSession(); } },
			});
			created.setToolUIContext(runtimeUi, true);
			await live.setActiveToolsByName(parentTools);
			for (const name of live.getAllToolNames()) guardTool(name);
			logicalTools = live.getEnabledToolNames();
			const missing = parentTools.filter(name => !logicalTools.includes(name));
			if (missing.length) throw new Error("SIDE 工具注册不完整：" + missing.join(", "));
			const extra = logicalTools.filter(name => !parentTools.includes(name));
			if (extra.length) throw new Error("SIDE 注册了父会话没有的工具：" + extra.join(", "));
			directTools = live.agent.state.tools.map(tool => tool.name);
			bridgeTools = live.getEvalBridgeToolNames?.() ?? [];
			sessionCapabilities.set(live, capability);
			return live;
		} catch (e) { await live.dispose({ drainTimeoutMs: 2_000 }); throw e; }
	};
	/** Single-flight session creation shared by runAsk and the idle prewarm. epoch guards against
	 *  races with dropSession: a late-resolving build is disposed instead of installed, and the
	 *  identity-guarded cleanup never clears a newer single-flight slot. */
	const ensureSession = async (currentTurnId: string, preserved?: AgentMessage[]): Promise<AgentSession> => {
		if (sessionPromise) return sessionPromise;
		if (session) return session;
		const epoch = sessionEpoch;
		const built = buildSession(currentTurnId, preserved).then(live => {
			if (epoch !== sessionEpoch || disposed || closing) { void live.dispose({ drainTimeoutMs: 2_000 }).catch(() => {}); throw new Error("SIDE 会话构建已过期"); }
			session = live; return live;
		});
		sessionPromise = built;
		void built.then(() => { if (sessionPromise === built) sessionPromise = undefined; },
			() => { if (sessionPromise === built) sessionPromise = undefined; });
		return built;
	};
	/** Spec'd optional warm-up: while idle, open a session in the background so the first prompt skips setup.
	 *  Replays every recorded turn — only runAsk's freshly-pushed (still-answerless) turn may be excluded. */
	const prewarm = (): void => {
		if (disposed || busy || deleting || switching || closing || session || sessionPromise || !snapshot || !turns.length) return;
		void ensureSession("").catch(() => { /* keep first real ask as the fallback path */ });
	};
	const runAsk = async (question: string): Promise<void> => {
		if (busy || deleting || switching || closing || disposed || !question.trim()) return;
		const turn: Turn = { id: crypto.randomUUID(), at: Date.now(), question: question.trim(), answer: "", status: "starting", tools: [], messages: [] };
		if (threadId !== LEGACY_THREAD) turn.threadId = threadId;
		turns.push(turn);
		selectedId = turn.id;
		busy = true;
		const current = ++generation;
		liveSegments = []; liveVersion++;
		saveError = undefined;
		status = "准备 SIDE 上下文";
		render();
		const eventMessages: AgentMessage[] = [];
		let before = -1;
		let beforeLast: AgentMessage | undefined;
		const recordMessages = () => {
			if (eventMessages.length && eventMessages[0]?.role !== "user")
				eventMessages.unshift({ role: "user", content: turn.question, timestamp: turn.at } as AgentMessage);
			turn.messages = eventMessages; touch(turn);
		};
		try {
			const ctx = hooks.getCtx();
			if (ctx.sessionManager.getSessionId() !== hooks.mainSessionId || ctx.cwd !== hooks.cwd) throw new Error("主会话已切换；此 SIDE 已停用。");
			if (!snapshot) {
				const captured = takeSnapshot(ctx);
				await saveMetadata(directory, { ...metadata, snapshot: captured });
				snapshot = captured;
				metadata.snapshot = captured;
				contextError = undefined;
				status = "主上下文已准备 " + captured.messages.length + " 条";
				render();
			}
			await save(turn);
			if (disposed || current !== generation) return;
			let live = await ensureSession(turn.id);
			if (disposed || current !== generation) return;
			const previous = sessionCapabilities.get(live);
			if (!previous || !sameCapabilities(previous, capabilities(hooks.getParent()))) {
				const preserved = structuredClone(live.messages);
				await dropSession();
				if (disposed || current !== generation) return;
				live = await ensureSession(turn.id, preserved);
			}
			if (disposed || current !== generation) return;
			contextError = undefined;
			status = "已同步主会话工具；保留 SIDE 原有上下文";
			before = live.agent.state.messages.length;
			beforeLast = live.agent.state.messages.at(-1);
			unsubscribe?.();
			unsubscribe = live.agent.subscribe(event => {
				if (disposed || current !== generation) return;
				if (event.type === "message_start" && event.message?.role === "assistant") { liveSegments.push({ kind: "text", text: "" }); liveVersion++; }
				if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
					const delta = event.assistantMessageEvent.delta as string;
					touch(turn).answer += delta; liveVersion++;
					let last = liveSegments.at(-1);
					if (!last || last.kind !== "text") { last = { kind: "text", text: "" }; liveSegments.push(last); }
					last.text += delta;
					render();
				}
				if (event.type === "message_end" && ["user", "assistant", "toolResult"].includes(event.message?.role)) {
					eventMessages.push(structuredClone(event.message));
					recordMessages();
					if (event.message.role === "assistant") {
						const last = liveSegments.at(-1);
						if (last?.kind === "text") last.done = true;
					}
					if (event.message.role === "toolResult") {
						const tool = liveSegments.findLast(s => s.kind === "tool" && s.id === event.message.toolCallId);
						if (tool?.kind === "tool") tool.done = true;
					}
					liveVersion++;
					void save(turn).catch(() => {});
					render();
				}
				if (event.type === "tool_execution_start") {
					touch(turn).tools.push(event.toolName);
					liveSegments.push({ kind: "tool", id: event.toolCallId, name: event.toolName, args: structuredClone(event.args) });
					liveVersion++;
					status = "正在调用：" + event.toolName;
					render();
				}
				if (event.type === "tool_execution_update") {
					const tool = liveSegments.findLast(s => s.kind === "tool" && s.id === event.toolCallId);
					if (tool?.kind === "tool") { tool.partial = structuredClone(event.partialResult); liveVersion++; }
					render();
				}
				if (event.type === "tool_execution_end") {
					const tool = liveSegments.findLast(s => s.kind === "tool" && s.id === event.toolCallId);
					if (tool?.kind === "tool") { tool.result = structuredClone({ ...event.result, isError: event.isError }); liveVersion++; }
					status = event.isError ? "工具失败：" + event.toolName : "工具完成：" + event.toolName;
					render();
				}
				if (event.type === "auto_compaction_start") { status = "SIDE 压缩中…"; render(); }
				if (event.type === "auto_compaction_end") {
					if (!event.aborted && (event.result != null || event.skipped === false)) { compacted = true; contextError = undefined; }
					else if (event.errorMessage) contextError = "SIDE 压缩失败：" + errorText(event.errorMessage);
					render();
				}

			});
			unsubscribeSession?.();
			unsubscribeSession = typeof live.subscribe === "function" ? live.subscribe((event: any) => {
				if (disposed || current !== generation) return;
				if (event.type === "auto_compaction_start") { status = "SIDE 压缩中…"; render(); }
				if (event.type === "auto_compaction_end") {
					if (!event.aborted && (event.result != null || event.skipped === false)) { compacted = true; contextError = undefined; }
					else if (event.errorMessage) contextError = "SIDE 压缩失败：" + errorText(event.errorMessage);
					render();
				}
			}) : undefined;
			touch(turn).status = "running";
			status = "SIDE 回答中";
			render();
			const dispatched = await live.prompt(turn.question, { expandPromptTemplates: false, userInitiated: false, attribution: "user" });
			if (disposed || current !== generation) return;
			if (!dispatched) throw new Error("旁路问题未发送给模型。");
			const after = live.agent.state.messages;
			turn.messages = before === 0 || after[before - 1] === beforeLast ? structuredClone(after.slice(before)) : structuredClone(eventMessages);
			if (!turn.messages.length) throw new Error("旁路没有可保存的消息链。");
			const assistants = turn.messages.filter(m => m.role === "assistant");
			const last = assistants.at(-1) as any;
			if (last?.stopReason === "error") throw new Error(last.errorMessage || "模型请求失败");
			if (!last) throw new Error("旁路未收到模型回答。");
			turn.answer = last.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
			touch(turn).status = "complete";
			status = "回答完成；可追问，F1 可将选中回答回填 main 草稿";
		} catch (e) {
			if (!disposed && current === generation) {
				turn.status = "error";
				turn.error = errorText(e);
				touch(turn);
				contextError = contextError ?? (session ? undefined : turn.error);
				status = "旁路失败：" + turn.error;
				stashDraft(turn.question);
			}
		} finally {
			if (turn.status === "starting" || turn.status === "running") touch(turn).status = "cancelled";
			if (current !== generation) await session?.agent.waitForIdle().catch(e => { status = "取消等待失败：" + errorText(e); });
			// After a cancel the subscription is generation-gated, so rebuild the message chain from the
			// native session state: partial assistant output and late toolResults are preserved honestly.
			if (session && before >= 0 && turn.status !== "complete") {
				const after = session.agent.state.messages;
				const sliced = before === 0 || after[before - 1] === beforeLast ? after.slice(before) : undefined;
				if (sliced && sliced.length) turn.messages = structuredClone(sliced);
			}
			if (!turn.messages?.length && eventMessages.length) recordMessages();
			touch(turn);
			await save(turn).catch(() => {});
			await saves;
			busy = false;
			liveSegments = []; liveVersion++;
			if (!disposed) render();
		}
	};
	const invalidateTurn = (id: string, index: number) => {
		for (const key of [...view.blockCache.keys()]) if (key.startsWith(id + ":")) view.blockCache.delete(key);
		selectedId = turns.length ? turns[Math.min(index, turns.length - 1)]!.id : undefined;
		if (view.scrollAnchor.turnId === id) view.scrollAnchor = { turnId: selectedId, offset: 0 };
		view.followTail = false;
		render();
	};
	const deleteTurn = async (id: string): Promise<void> => {
		if (busy || deleting || switching || savesPending || disposed) { status = "请先取消或等待旁路操作完成，再删除历史"; render(); return; }
		deleting = true;
		deleteCandidateId = undefined;
		status = "正在删除旁路问答…";
		render();
		const task = (async () => {
			const index = turns.findIndex(t => t.id === id);
			if (index < 0) { status = "该问答已不存在"; return; }
			try {
				await removeTurn(directory, id);
				turns.splice(index, 1);
				invalidateTurn(id, index);
				const cleanup = await dropSession();
				status = cleanup ? "记录已删除，但 SIDE 清理失败：" + cleanup : "已删除所选旁路问答";
			} catch (e) { status = "旁路历史删除失败：" + errorText(e); }
		})();
		pendingMutation = task;
		try { await task; } finally { deleting = false; pendingMutation = undefined; render(); }
	};
	/** Closing releases the runtime, never the fork/history. Hiding never calls this. */
	const closeSession = (): Promise<void> => {
		if (closePromise) return closePromise;
		closing = true;
		cancelRequest("interrupted");
		const building = sessionPromise, mutation = pendingMutation;
		status = "正在关闭 SIDE；等待工具收尾"; render();
		closePromise = (async () => {
			if (pendingAsk) await pendingAsk;
			if (building) await building.catch(() => {});
			if (mutation) await mutation;
			await saves;
			const cleanup = await dropSession();
			if (cleanup) throw new Error(cleanup);
			status = "SIDE 已关闭；历史已保留，待确认请求已取消";
		})().catch(error => { status = "SIDE 关闭失败：" + errorText(error); throw error; })
			.finally(() => { closing = false; closePromise = undefined; render(); });
		return closePromise;
	};
	const deleteThread = async (ids: string[]): Promise<{ ok: boolean; deleted: number; remaining: number; error?: string }> => {
		if (deleting || switching || closing || disposed) return { ok: false, deleted: 0, remaining: turns.length, error: "SIDE 正在切换或关闭，请稍后丢弃" };
		if (ids.length !== turns.length || ids.some((id, i) => turns[i]?.id !== id)) return { ok: false, deleted: 0, remaining: turns.length, error: "会话内容已变化，请重新确认" };
		deleting = true; status = "正在删除整段 SIDE 会话…"; render();
		const task = (async () => {
			try { await closeSession(); }
			catch (error) { return { ok: false, deleted: 0, remaining: turns.length, error: errorText(error) }; }
			let deleted = 0;
			let failure: string | undefined;
			for (const id of ids) {
				try { await removeTurn(directory, id); }
				catch (e) { failure = errorText(e); break; }
				const index = turns.findIndex(t => t.id === id);
				if (index >= 0) { turns.splice(index, 1); invalidateTurn(id, index); }
				deleted++;
		}
			const cleanup = deleted ? await dropSession() : undefined;
			if (!failure) {
				try { await removeFile(metaPath(directory, threadId)); }
				catch (e) { failure = "角色元数据删除失败：" + errorText(e); }
			}
			const remaining = turns.length;
			const ok = !failure && remaining === 0;
			status = ok ? "已删除整段 SIDE 会话" : `已删 ${deleted} 条，剩余 ${remaining} 条：${failure ?? "未知错误"}`;
			if (cleanup) status += "；旧 SIDE 清理失败：" + cleanup;
			return { ok, deleted, remaining, error: failure ?? cleanup };
		})();
		pendingMutation = task;
		try { return await task; }
		finally { deleting = false; pendingMutation = undefined; render(); }
	};
	const switchModel = async (next: string): Promise<string> => {
		if (next === spec) return "模型角色已为 " + spec;
		if (busy || deleting || switching || savesPending || disposed) return "旁路正忙；未切换角色，仍为 " + spec;
		switching = true; render();
		const task = (async () => {
			try {
				requireRole(hooks.getCtx(), hooks.getSettings(), next);
				await saveMetadata(directory, { ...metadata, modelRole: next, snapshot });
				metadata.modelRole = next;
				const cleanup = await dropSession();
				spec = next;
				status = "已切换 SIDE 角色为 " + spec + (cleanup ? "；旧会话清理失败：" + cleanup : "");
			} catch (e) { status = "角色切换失败，仍为 " + spec + "：" + errorText(e); }
			return status;
		})();
		pendingMutation = task;
		try { return await task; }
		finally { switching = false; pendingMutation = undefined; render(); }
	};
	const disposeController = (): Promise<void> => {
		disposePromise ??= (async () => {
			disposed = true;
			cancelRequest();
			cancelInteractions();
			syncGate();
			if (closePromise) await closePromise.catch(() => {});
			if (pendingAsk) await pendingAsk.catch(() => {});
			if (pendingMutation) await pendingMutation.catch(() => {});
			await saves;
			await dropSession();
		})();
		return disposePromise;
	};
	editor.onSubmit = value => {
		if (!value.trim() || busy || deleting || switching || closing || disposed) return;
		editor.addToHistory(value);
		view.page = "chat";
		view.followTail = true;
		pendingAsk = runAsk(value);
	};
	return {
		threadId, turns, view,
		get busy() { return busy; }, get deleting() { return deleting; }, get closing() { return closing; }, get switching() { return switching || closing; }, get disposed() { return disposed; },
		get spec() { return spec; },
		get modelName() { const model = session?.model; return model ? model.provider + "/" + model.id + ":" + session?.thinkingLevel : spec; },
		get status() { return [status, ...extensionStatuses.values(), ...(saveError ? ["历史保存失败：" + saveError] : [])].join("；"); }, get snapshot() { return snapshot; },
		get contextState(): ContextState { return contextError ? "error" : compacted ? "compacted" : session ? "loaded" : snapshot ? "prepared" : "unprepared"; },
		get contextError() { return contextError; }, get logicalTools() { return logicalTools; }, get directTools() { return directTools; }, get bridgeTools() { return bridgeTools; },
		get liveSegments() { return liveSegments; }, get session() { return session; }, get deleteCandidateId() { return deleteCandidateId; },
		get liveVersion() { return liveVersion; },
		setStatus(value) { status = value; render(); }, setDeleteCandidate(id) { deleteCandidateId = id; render(); },
		selectedIndex, selectByIndex(index) { if (turns.length) selectedId = turns[Math.max(0, Math.min(turns.length - 1, index))]!.id; render(); },
		selectedTurn() { return turns[selectedIndex()]; }, stashDraft, prewarm,
		ask(question) { pendingAsk = runAsk(question); }, cancelRequest, closeSession, deleteTurn, deleteThread, switchModel, disposeController,
		shiftInteraction() { const item = queue.shift(); if (item) inflight.add(item); return item; }, settleInteraction, failInteraction,
	};
}

type UiComponent = Component & { dispose?(): void };
/** Preserve native focus/cursor ownership without mutating extension components. */
function wrapUiComponent(inner: UiComponent, handleInput: (data: string) => void,
	render: (width: number) => string[] = width => inner.render(width)): UiComponent {
	const wrapped: UiComponent = { render, handleInput,
		invalidate: () => inner.invalidate(), dispose: () => inner.dispose?.() };
	for (const key of ["focused", "wantsKeyRelease", "cursor", "overlay"] as const)
		if (key in inner) Object.defineProperty(wrapped, key, { get: () => Reflect.get(inner, key), set: value => { Reflect.set(inner, key, value); } });
	return wrapped;
}

/** One arbiter per native UI object, not a global prototype patch. Native custom()
 * bypasses OMP's selector FIFO; route every functional dialog through this queue.
 * The long-lived SIDE view itself uses surface(), outside the dialog queue. */
interface UiArbiter {
	ui: ExtensionUIContext;
	surface: ExtensionUIContext["custom"];
	side<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T>;
	idle(): Promise<void>;
	beforePresent(listener: () => void): () => void;
}
const uiArbiters = new WeakMap<ExtensionUIContext, UiArbiter>();
function uiArbiter(ui: ExtensionUIContext): UiArbiter {
	const existing = uiArbiters.get(ui);
	if (existing) return existing;
	const scope = new AsyncLocalStorage<symbol>();
	const queue: Array<() => void> = [], idleWaiters: Array<() => void> = [];
	const listeners = new Set<() => void>();
	let active: symbol | undefined;
	const next = () => {
		const start = queue.shift();
		if (start) start(); else { active = undefined; for (const resolve of idleWaiters.splice(0)) resolve(); }
	};
	function submit<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		return new Promise<T>((resolve, reject) => {
			let cancelled = false, started = false;
			const abort = () => { if (!started) { cancelled = true; reject(signal?.reason); } };
			signal?.addEventListener("abort", abort, { once: true });
			const start = () => {
				signal?.removeEventListener("abort", abort);
				if (cancelled) { next(); return; }
				started = true;
				const token = active = Symbol("dialog");
				void scope.run(token, async () => {
					for (const listener of listeners) listener();
					return run();
				}).then(resolve, reject).finally(next);
			};
			if (active) queue.push(start); else start();
		});
	}
	const surface = ui.custom.bind(ui);
	for (const kind of ["select", "confirm", "input", "editor", "askDialog", "custom"] as const) {
		const original = ui[kind];
		if (!original) continue;
		const invoke = (args: unknown[]): Promise<unknown> => {
			if (kind === "custom") {
				// Bind key callbacks too: nested SIDE input must not queue behind itself.
				const factory = args[0] as Parameters<ExtensionUIContext["custom"]>[0], token = scope.getStore()!;
				args[0] = async (...factoryArgs: Parameters<typeof factory>) => {
					const component = await factory(...factoryArgs);
					return wrapUiComponent(component, data => scope.run(token, () => component.handleInput?.(data)));
				};
			}
			return Reflect.apply(original, ui, args);
		};
		const wrapped = (...args: unknown[]): Promise<unknown> => {
			// A SIDE submission or nested dialog already owns the surface.
			if (active && scope.getStore() === active) return invoke(args);
			const options = args[kind === "custom" || kind === "askDialog" ? 1 : 2];
			const signal = options && typeof options === "object" && "signal" in options && options.signal instanceof AbortSignal ? options.signal : undefined;
			return submit(async () => {
				ui.setStatus("side.dialog-origin", "MAIN");
				try {
					return await invoke(args);
				} finally { ui.setStatus("side.dialog-origin", undefined); }
			}, signal).catch(error => { if (signal?.aborted && kind !== "custom") return denied(kind); throw error; });
		};
		// Preserve each native method's generic signature across the private queue.
		Reflect.set(ui, kind, wrapped);
	}
	const arbiter: UiArbiter = { ui, surface,
		side: (run, signal) => signal.aborted ? Promise.reject(signal.reason) : active && scope.getStore() === active ? run() : submit(run, signal),
		idle: () => active ? new Promise<void>(resolve => idleWaiters.push(resolve)) : Promise.resolve(),
		beforePresent: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
	uiArbiters.set(ui, arbiter);
	return arbiter;
}
type ThreadEntry = { id: string; created: number; turns: Turn[]; metadata?: ThreadMetadata; controller?: SideController };
type ViewExit = { kind: "return" } | { kind: "copy"; text: string } | { kind: "pause" };
interface SideManager {
	mainSessionId: string; cwd: string;
	open(ctx: ExtensionCommandContext, args: ParsedArgs): Promise<void>;
	detachView(): void; disposeManager(): Promise<void>;
}
function createSideManager(ctx: ExtensionCommandContext, directory: string): SideManager {
	const mainSessionId = ctx.sessionManager.getSessionId(), cwd = ctx.cwd;
	const parent = mainSession(ctx), parentSettings = parent.settings;
	const nativeUi = parent.extensionRunner?.getUIContext();
	if (!nativeUi) throw new Error("主会话交互界面不可用");
	const arbitration = uiArbiter(nativeUi);
	const getParentTools = () => parent.getEnabledToolNames().filter(name => !SIDE_DENIED_TOOLS.has(name));
	let currentCtx = ctx, disposed = false;
	let creationPromise: Promise<void> | undefined;
	let disposePromise: Promise<void> | undefined, deletionPromise: Promise<void> | undefined;
	let selectedId: string | undefined, showRoster = true, rosterOffset = 0;
	let rosterStatus = "正在载入 SIDE 历史…";
	let pendingSpec: string | undefined, pendingQuestion: string | undefined, draftBlocked = false;
	let loadState: "loading" | "ready" | "error" = "loading", loadError = "", loadPromise: Promise<void> | undefined;
	let rosterFilter = "", rosterFiltering = false;
	let confirmThread: { id: string; ids: string[]; title: string } | undefined;
	let mount: { token: number; tui: TUI; finish: (result: ViewExit) => void; dirty?: () => void } | undefined;
	const detachPresenter = arbitration.beforePresent(() => mount?.finish({ kind: "pause" }));
	let presenting: SideController | undefined;
	const detachInput = nativeUi.onTerminalInput(data => {
		if (!presenting || !matchesKey(data, "ctrl+w")) return;
		const target = presenting;
		showRoster = true; selectedId = target.threadId; confirmThread = undefined;
		void target.closeSession().catch(error => { rosterStatus = errorText(error); poke(); });
		return { consume: true };
	});
	let nextToken = 0;
	/** Single render-request choke point: routes through the component's batched repaint when mounted. */
	const poke = (): void => { if (mount?.dirty) mount.dirty(); else mount?.tui.requestRender(); };
	const threads = new Map<string, ThreadEntry>();
	const title = (entry: ThreadEntry): string => entry.id === LEGACY_THREAD ? "旧旁路" : entry.turns.length ? line(entry.turns[0]!.question) : "新会话";
	const ordered = (): ThreadEntry[] => [...threads.values()].sort((a, b) =>
		(b.turns.at(-1)?.at ?? b.created) - (a.turns.at(-1)?.at ?? a.created) || a.id.localeCompare(b.id));
	const rosterRows = (): RosterRow[] => {
		const needle = rosterFilter.trim().toLowerCase();
		const list = needle ? ordered().filter(e => title(e).toLowerCase().includes(needle) || e.turns.some(t => t.question.toLowerCase().includes(needle))) : ordered();
		return [{ kind: "new" }, ...list.map((entry): RosterRow => ({ kind: "thread", entry }))];
	};
	const rosterIndex = (): number => {
		const rows = rosterRows();
		if (selectedId === NEW_ROW_ID) return 0;
		const index = rows.findIndex(r => r.kind === "thread" && r.entry.id === selectedId);
		if (index >= 0) return index;
		// Selection hidden by filter or deleted: sync selectedId to the row actually highlighted.
		const fallback = rows.length > 1 ? 1 : 0, row = rows[fallback];
		selectedId = row?.kind === "thread" ? row.entry.id : NEW_ROW_ID;
		return fallback;
	};
	const rosterEntry = (): ThreadEntry | undefined => {
		const row = rosterRows()[rosterIndex()];
		return row?.kind === "thread" ? row.entry : undefined;
	};
	const selected = (): ThreadEntry | undefined => selectedId === NEW_ROW_ID ? undefined : ordered().find(e => e.id === selectedId) ?? ordered()[0];
	const reload = (): void => {
		if (loadPromise) return;
		loadState = "loading"; loadError = ""; rosterStatus = "正在载入 SIDE 历史…";
		loadPromise = (async () => {
			try {
				const [turns, metas] = await Promise.all([loadTurns(directory), loadMetadata(directory)]);
				for (const turn of turns) {
					const id = threadKey(turn);
					let entry = threads.get(id);
					if (!entry) { entry = { id, created: turn.at, turns: [] }; threads.set(id, entry); }
					entry.turns.push(turn);
				}
				for (const meta of metas) {
					let entry = threads.get(meta.threadId);
					if (!entry) { entry = { id: meta.threadId, created: meta.created, turns: [] }; threads.set(meta.threadId, entry); }
					entry.metadata = meta;
				}
				loadState = "ready";
				if (rosterStatus === "正在载入 SIDE 历史…") rosterStatus = turns.length ? "已载入 SIDE 历史" : "等待 SIDE 问题";
			} catch (error) {
				loadState = "error"; loadError = errorText(error);
				rosterStatus = "SIDE 历史读取失败：" + loadError;
			}
		})().finally(() => { loadPromise = undefined; poke(); });
	};
	const hooks: ControllerHooks = {
		mainSessionId, cwd, getCtx: () => currentCtx, getParent: () => parent, getParentTools, getSettings: () => parentSettings,
		notifyView: poke,
		requestInteraction: id => {
			const c = threads.get(id)?.controller;
			if (!c) return;
			let item: Interaction | undefined;
			while ((item = c.shiftInteraction())) {
				const request = item;
				void arbitration.side(() => nativeInteraction(request, c, nativeUi), request.abort.signal)
					.catch(error => c.failInteraction(request, error));
			}
		},
	};
	const controller = (entry: ThreadEntry, spec = DEFAULT_MODEL): SideController => {
		entry.controller ??= createSideController(entry.metadata ?? { version: 1, threadId: entry.id, created: entry.created, modelRole: spec }, directory, entry.turns, hooks);
		return entry.controller;
	};
	/** Send the pending draft into a chosen thread; busy threads get it stashed into their editor instead. */
	const sendOrStash = (entry: ThreadEntry, question: string): void => {
		const c = controller(entry);
		if (c.busy || c.deleting || c.switching) { c.stashDraft(question); c.setStatus("请求正忙；问题已保留为该会话草稿"); rosterStatus = "草稿已存入会话编辑器"; }
		else { c.view.page = "chat"; c.view.followTail = true; c.ask(question); }
	};
	const detachView = () => { const m = mount; mount = undefined; m?.finish({ kind: "return" }); };
	const disposeManager = (): Promise<void> => {
		disposePromise ??= (async () => {
			disposed = true; detachView();
			detachPresenter();
			detachInput();
			if (creationPromise) await creationPromise;
			if (deletionPromise) await deletionPromise;
			await Promise.all([...threads.values()].map(e => e.controller?.disposeController()));
		})();
		return disposePromise;
	};
	const deleteThread = (candidate: { id: string; ids: string[]; title: string }) => {
		if (deletionPromise) return;
		const entry = threads.get(candidate.id);
		if (!entry) { rosterStatus = "会话已不存在"; poke(); return; }
		const c = controller(entry);
		deletionPromise = (async () => {
			const outcome = await c.deleteThread(candidate.ids);
			if (outcome.ok) {
				threads.delete(candidate.id);
				selectedId = ordered()[0]?.id;
				rosterStatus = "已删除 SIDE 会话：" + candidate.title;
				await c.disposeController();
			} else rosterStatus = `已删 ${outcome.deleted} 条，剩余 ${outcome.remaining} 条：${outcome.error ?? "未知错误"}`;
		})().finally(() => { deletionPromise = undefined; poke(); });
	};
	async function nativeInteraction(item: Interaction, c: SideController, ui: ExtensionCommandContext["ui"]): Promise<void> {
		if (item.settled || c.disposed) return;
		const entry = threads.get(item.threadId);
		if (!entry) { c.settleInteraction(item, denied(item.kind)); return; }
		const tag = "SIDE · " + title(entry) + " · " + entry.id.slice(0, 8);
		const caption = (text: string) => tag + " · " + text;
		const opts = <T extends { signal?: AbortSignal }>(base?: T) => ({ ...base,
			signal: base?.signal ? AbortSignal.any([base.signal, item.abort.signal]) : item.abort.signal });
		const previous = presenting;
		presenting = c;
		ui.setStatus("side.dialog-origin", tag + " · Ctrl+w 关闭并取消待答交互");
		try {
			let result: unknown;
			// These tuples came only from the typed sideUi methods, never from external JSON.
			switch (item.kind) {
				case "select": {
					const [label, choices, options] = item.args as Parameters<ExtensionUIContext["select"]>;
					result = await ui.select(caption(label), choices, opts(options)); break;
				}
				case "confirm": {
					const [label, message, options] = item.args as Parameters<ExtensionUIContext["confirm"]>;
					result = await ui.confirm(caption(label), message, opts(options)); break;
				}
				case "input": {
					const [label, placeholder, options] = item.args as Parameters<ExtensionUIContext["input"]>;
					result = await ui.input(caption(label), placeholder, opts(options)); break;
				}
				case "editor": {
					const [label, prefill, options, editorOptions] = item.args as Parameters<ExtensionUIContext["editor"]>;
					result = await ui.editor(caption(label), prefill, opts(options), editorOptions); break;
				}
				case "askDialog": {
					if (!ui.askDialog) throw new Error("本机 OMP 不支持 SIDE askDialog");
					const [questions, options] = item.args as Parameters<NonNullable<ExtensionUIContext["askDialog"]>>;
					const response = await ui.askDialog(questions.map(q => ({ ...q, question: caption(q.question) })), opts(options));
					// Origin labels are presentation only; preserve the caller's answer metadata.
					if (response?.kind === "submit") for (const answer of response.results) {
						const original = questions.find(question => question.id === answer.id);
						if (original) answer.question = original.question;
					}
					result = response; break;
				}
				case "custom": {
					const [factory, options] = item.args as Parameters<ExtensionUIContext["custom"]>;
					result = await ui.custom(async (tui, theme, keys, done) => {
						const inner = await factory(tui, theme, keys, done);
						return wrapUiComponent(inner, data => inner.handleInput?.(data), width => {
								const innerLines = inner.render(width);
								const tagLine = truncateToWidth(theme.fg("accent", tag), Math.max(1, width));
								// A full-height inner component must not be pushed past the terminal rows:
								// merge the SIDE tag into its first line instead of adding a line.
								if (innerLines.length + 1 > Math.max(1, tui.terminal.rows) && innerLines.length) {
									const room = Math.max(0, width - visibleWidth(tag) - 1);
									return [truncateToWidth(tagLine + " " + truncateToWidth(innerLines[0]!, room), width), ...innerLines.slice(1)];
								}
								return [tagLine, ...innerLines];
						});
					}, opts(options));
					break;
				}
			}
			c.settleInteraction(item, result);
		} catch (error) { c.failInteraction(item, error); }
		finally {
			if (presenting === c) presenting = previous;
			ui.setStatus("side.dialog-origin", previous ? "SIDE · " + previous.threadId.slice(0, 8) + " · Ctrl+w 关闭并取消待答交互" : undefined);
		}
	}
	const open = async (openCtx: ExtensionCommandContext, args: ParsedArgs): Promise<void> => {
		if (disposed || openCtx.sessionManager.getSessionId() !== mainSessionId || openCtx.cwd !== cwd) return;
		currentCtx = openCtx;
		if (args.explicitModel) {
			try { requireRole(openCtx, parentSettings, args.spec); pendingSpec = args.spec; rosterStatus = "待发角色 " + args.spec; }
			catch (error) { pendingSpec = undefined; draftBlocked = !!args.question; rosterStatus = "角色无效，草稿未发送：" + errorText(error); }
		}
		if (args.question) { pendingQuestion = args.question; selectedId = NEW_ROW_ID; if (!args.explicitModel) draftBlocked = false; }
		showRoster = true; rosterFilter = ""; rosterFiltering = false;
		if (mount) { poke(); return; }
		while (!disposed) {
			const token = ++nextToken;
			await arbitration.idle();
			if (disposed) return;
			const exit = await arbitration.surface<ViewExit>((tui, theme, _keybindings, done): Component => {
				const timeline = new ScrollView([], { height: 1, scrollbar: "auto",
					theme: { track: text => theme.fg("dim", text), thumb: text => theme.fg("accent", text) } });
				const toolComponents = new Map<string, InstanceType<typeof ToolExecutionComponent>>();
				let restoreScroll = true, synced = false, lastHeight = 1;
				let renderedId: string | undefined, aux: "role" | "context" | undefined;
				let roleIndex = 0, roleOffset = 0, helpOffset = 0, roleForNew = false;
				type SideAction = "new" | "filter" | "retry" | "history" | "copy" | "tools" | "role" | "context" | "latest" | "delete" | "discard" | "cancel" | "close";
				let actions: { id: SideAction; label: string }[] | undefined, actionIndex = 0, actionPageSize = 1;
				let lastLines: readonly string[] | undefined, finished = false;
				let composerVisible = false;
				let viewTick = 0, paintedTick = -1, paintQueued = false, lastKey = "";
				mount = { token, tui, finish: result => { if (!finished) { finished = true; done(result); } } };
				const finish = (result: ViewExit) => { if (mount?.token === token) mount.finish(result); };
				/** Batched repaint: multiple invalidations inside one tick coalesce into a single requestRender. */
				const repaint = () => {
					viewTick++;
					if (paintQueued) return;
					paintQueued = true;
					queueMicrotask(() => { paintQueued = false; tui.requestRender(); });
				};
				mount.dirty = repaint;
				const active = (): SideController | undefined => (!showRoster || aux) && selected() ? controller(selected()!) : undefined;
				const fit = (s: string, width: number) => truncateToWidth(s, Math.max(1, width));
				const tc = theme.getColorMode() === "truecolor";
				/** Selected row: surface0 background across the full width; inner chips restore it after their own bg reset. */
				const selLine = (text: string, width: number) => bg256("surface0", tc) + text + " ".repeat(Math.max(0, width - visibleWidth(text))) + RESET;
				const rolesNow = (): RoleInfo[] => roles(currentCtx, parentSettings);
				const rosterSelect = (index: number) => {
					const rows = rosterRows();
					if (!rows.length) return;
					const row = rows[Math.max(0, Math.min(rows.length - 1, index))]!;
					selectedId = row.kind === "new" ? NEW_ROW_ID : row.entry.id;
				};
				/** Enter a thread: apply any pending role first, then send or stash the pending draft. */
				const openEntry = (entry: ThreadEntry, isNew: boolean) => {
					const question = pendingQuestion, spec = pendingSpec;
					if (question && draftBlocked) {
						rosterStatus = "角色无效，草稿未发送；F1 选择有效模型角色后再发";
						if (!isNew) { selectedId = entry.id; showRoster = false; rosterFiltering = false; restoreScroll = true;
							controller(entry).setStatus("角色无效，草稿未发送；回列表用 F1 选择有效模型角色"); }
						repaint(); return;
					}
					const existing = entry.controller;
					if (existing?.deleting) { rosterStatus = "会话删除中，草稿未发送"; repaint(); return; }
					selectedId = entry.id; showRoster = false; rosterFiltering = false; restoreScroll = true;
					pendingQuestion = undefined; pendingSpec = undefined;
					if (rosterStatus.startsWith("待发角色")) rosterStatus = "等待 SIDE 问题";
					const c = controller(entry, isNew && spec ? spec : DEFAULT_MODEL);
					if (spec && c.spec !== spec) {
						c.setStatus("正在切换角色为 " + spec + "…");
						void c.switchModel(spec).then(() => {
							if (question) { if (c.spec === spec) sendOrStash(entry, question); else { c.stashDraft(question); c.setStatus("角色切换失败；草稿已存入编辑器，未发送"); } }
							poke();
						});
					} else if (question) sendOrStash(entry, question);
					else queueMicrotask(() => c.prewarm());
				};
				const startNew = () => {
					if (creationPromise) return;
					if (pendingQuestion && draftBlocked) { rosterStatus = "角色无效，草稿未发送；F1 选择有效模型角色后再发"; repaint(); return; }
					try {
						// Freeze before the first await, not later when the user submits a question.
						const captured = takeSnapshot(currentCtx), id = crypto.randomUUID(), created = Date.now();
						const metadata: ThreadMetadata = { version: 1, threadId: id, created, modelRole: pendingSpec ?? DEFAULT_MODEL, snapshot: captured };
						const entry: ThreadEntry = { id, created, turns: [], metadata };
						rosterStatus = "正在保存新 SIDE 快照…";
						creationPromise = saveMetadata(directory, metadata).then(() => {
							if (disposed) return;
							threads.set(id, entry);
							rosterStatus = "SIDE 快照已保存";
							if (!finished) openEntry(entry, true);
						}).catch(error => { rosterStatus = "SIDE 快照保存失败：" + errorText(error); })
							.finally(() => { creationPromise = undefined; poke(); });
					} catch (error) { rosterStatus = "SIDE 快照创建失败：" + errorText(error); }
					repaint();
				};
				const syncAnchor = (c: SideController) => {
					const offset = timeline.getScrollOffset();
					const range = c.view.blockRanges.find(r => offset < r.start + r.length) ?? c.view.blockRanges.at(-1);
					c.view.scrollAnchor = range ? { turnId: range.id, offset: Math.max(0, offset - range.start) } : { turnId: undefined, offset: 0 }; if (range) c.selectByIndex(c.turns.findIndex(t => t.id === range.id));
				};
				const anchorOffset = (c: SideController): number => {
					const range = c.view.blockRanges.find(r => r.id === c.view.scrollAnchor.turnId) ?? c.view.blockRanges.at(-1);
					return range ? range.start + Math.min(c.view.scrollAnchor.offset, range.length - 1) : 0;
				};
				const renderedToolKeys = new Set<string>();
				const drawTool = (c: SideController, turn: Turn, call: { id: string; name: string; args: unknown; result?: unknown; partial?: unknown; unknown?: boolean }, width: number): string[] => {
					const key = c.threadId + ":" + turn.id + ":" + call.id;
					if (call.unknown || (!call.result && turn.status !== "running" && turn.status !== "starting")) {
						toolComponents.get(key)?.dispose();
						toolComponents.delete(key);
						const args = clean(JSON.stringify(call.args ?? {}));
						return [theme.fg("warning", fit("工具 " + line(call.name) + " · 结果未知（可能已执行）", width)),
							...new Markdown(args, 0, 0, getMarkdownTheme()).render(width).map(s => fit(s, width))];
					}
					let component = toolComponents.get(key);
					if (!component) {
						const definition = c.session?.getToolByName(call.name);
						const args = JSON.parse(JSON.stringify(call.args ?? {}, (_k, v) => typeof v === "string" ? clean(v) : v));
						component = new ToolExecutionComponent(call.name, args, { useBuiltInRenderer: c.session?.hasBuiltInTool(call.name) ?? true, showImages: false }, definition, tui, cwd, call.id);
						component.setArgsComplete(call.id); component.setExecutionStarted(call.id);
						toolComponents.set(key, component);
					}
					component.setExpanded(c.view.toolsExpanded);
					if (call.result) component.updateResult(JSON.parse(JSON.stringify(call.result, (_k, v) => typeof v === "string" ? clean(v) : v)), false, call.id);
					else if (call.partial) component.updateResult(JSON.parse(JSON.stringify(call.partial, (_k, v) => typeof v === "string" ? clean(v) : v)), true, call.id);
					const lines = component.render(width).map(s => fit(s, width));
					return lines;
				};
				const block = (c: SideController, turn: Turn, index: number, width: number, compact: boolean): string[] => {
					const inner = Math.max(1, width - 1);
					const result = compact ? [] : [theme.fg("dim", "#" + (index + 1) + " · " + statusLabels[turn.status])];
					result.push(...new UserMessageComponent(clean(turn.question), theme).render(inner));
					if (turn.messages?.length) {
						const results = new Map<string, AgentMessage>();
						for (const m of turn.messages) if (m.role === "toolResult") results.set(m.toolCallId, m);
						const liveTool = (id: string) => c.liveSegments.find(s => s.kind === "tool" && s.id === id);
						const renderedTools = new Set<string>();
						for (const m of turn.messages) if (m.role === "assistant") for (const content of m.content) {
							if (content.type === "text" && content.text.trim()) result.push("", ...new Markdown(clean(content.text), 0, 0, getMarkdownTheme()).render(inner));
							if (content.type === "toolCall") {
								renderedTools.add(content.id);
								const match = results.get(content.id);
								const live = liveTool(content.id);
								result.push("", ...drawTool(c, turn, { id: content.id, name: content.name, args: content.arguments,
									result: match ? { content: match.content, details: match.details, isError: match.isError } : live?.result,
									partial: match || live?.result ? undefined : live?.partial,
									unknown: !!(match?.details && typeof match.details === "object" && (match.details as Record<string, unknown>).sideUnknownResult) }, inner));
							}
						}
						if (turn.status === "running" || turn.status === "starting") for (const segment of c.liveSegments) {
							if (segment.done) continue;
							if (segment.kind === "text" && segment.text.trim()) result.push("", ...new Markdown(clean(segment.text), 0, 0, getMarkdownTheme()).render(inner));
							if (segment.kind === "tool" && !renderedTools.has(segment.id)) result.push("", ...drawTool(c, turn, segment, inner));
						}
					} else {
						result.push("", ...new Markdown(clean(turn.answer || (turn.status === "running" ? "（等待回答）" : "（无回答）")), 0, 0, getMarkdownTheme()).render(inner));
						if (turn.tools.length) result.push(theme.fg("warning", "旧记录未保存工具结果：" + turn.tools.map(line).join(", ")));
					}
					if (turn.error) result.push(theme.fg("error", "错误：" + line(turn.error)));
					result.push(""); return result;
				};
				const ensureTimeline = (c: SideController, width: number, compact: boolean): boolean => {
					const v = c.view;
					if (!v.timelineDirty && v.timelineWidth === width && v.timelineCompact === compact && v.blockRanges.length === c.turns.length) return false;
					const lines: string[] = [], ranges: { id: string; start: number; length: number }[] = [];
					if (!c.turns.length) lines.push(theme.fg("muted", "还没有 SIDE 记录"), theme.fg("dim", "直接输入问题，Enter 发送"));
					renderedToolKeys.clear();
					for (const turn of c.turns) {
						for (const m of turn.messages ?? []) if (m.role === "assistant") for (const b of m.content)
							if (b.type === "toolCall") renderedToolKeys.add(c.threadId + ":" + turn.id + ":" + b.id);
						if (turn.status === "running" || turn.status === "starting") for (const s of c.liveSegments)
							if (s.kind === "tool") renderedToolKeys.add(c.threadId + ":" + turn.id + ":" + s.id);
					}
					const sigT0 = performance.now(), probe = !!process.env.SIDE_PERF;
					let legacySigMs = 0;
					c.turns.forEach((turn, index) => {
						const key = turn.id + ":" + width;
						// liveVersion only affects the currently running turn; finished turns keep a stable signature.
						const live = turn.status === "running" || turn.status === "starting";
						const signature = index + ":" + turn.version + ":" + turn.status + ":" + (v.toolsExpanded ? 1 : 0) + ":" +
							(compact ? 1 : 0) + ":" + (live ? c.liveVersion : 0);
						if (probe) { const t = performance.now(); void JSON.stringify([index, turn.status, turn.answer, turn.messages, v.toolsExpanded, compact, live ? c.liveSegments : undefined]); legacySigMs += performance.now() - t; }
						let cached = v.blockCache.get(key);
						if (!cached || cached.signature !== signature) {
							cached = { signature, lines: block(c, turn, index, width, compact) }; v.blockCache.set(key, cached);
							if (v.blockCache.size > 400) v.blockCache.delete(v.blockCache.keys().next().value!);
						}
						ranges.push({ id: turn.id, start: lines.length, length: cached.lines.length }); lines.push(...cached.lines);
					});
					if (probe) perfLog("ensureTimeline turns=" + c.turns.length + " total=" + (performance.now() - sigT0).toFixed(2) + "ms legacyStringify=" + legacySigMs.toFixed(2) + "ms");
					// Dispose tool cards whose turn was deleted or whose thread no longer exists.
					for (const [key, component] of [...toolComponents]) {
						const tid = key.slice(0, key.indexOf(":"));
						if (!threads.has(tid) || (tid === c.threadId && !renderedToolKeys.has(key))) { component.dispose(); toolComponents.delete(key); }
					}
					v.blockRanges = ranges; v.timelineLines = lines; v.timelineWidth = width; v.timelineCompact = compact; v.timelineDirty = false;
					return true;
				};
				/** Filter input row: keeps the tail visible so the cursor never overflows narrow panels. */
				const filterText = (width: number): string => {
					const room = Math.max(1, width - 7), chars = Array.from(rosterFilter);
					let shown = "", used = 0;
					for (let i = chars.length - 1; i >= 0; i--) { const w = visibleWidth(chars[i]!); if (used + w > room) break; used += w; shown = chars[i] + shown; }
					return fg256("yellow", tc) + "筛选: " + FG_RESET + shown + fg256("yellow", tc) + "▌" + FG_RESET + RESET;
				};
				const stamp = (t: number): string => { const d = new Date(t);
					return String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + " " +
						String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
				const rowState = (entry: ThreadEntry): string => entry.controller?.deleting ? "删除中" : entry.controller?.closing ? "关闭中" :
					entry.controller?.busy ? "回答中" : entry.controller?.switching ? "切换中" : entry.turns.at(-1) ? statusLabels[entry.turns.at(-1)!.status] : "空";
				/** Session-list panel content (no borders): selection ▌, status shown as ● dot + short word. */
				const rosterBody = (width: number, height: number): string[] => {
					const rows: string[] = [];
					const listH = Math.max(0, rosterFiltering ? height - 1 : height);
					if (loadState === "loading") rows.push(theme.fg("muted", "正在载入 SIDE 历史…"));
					else if (loadState === "error") rows.push(theme.fg("error", "SIDE 历史读取失败"), theme.fg("error", fit(loadError, width)), theme.fg("dim", "Enter 重试 · Esc 返回"));
					else {
						const list = rosterRows(), index = rosterIndex();
						if (index < rosterOffset) rosterOffset = index;
						if (index >= rosterOffset + listH) rosterOffset = index - listH + 1;
						rosterOffset = Math.max(0, Math.min(rosterOffset, Math.max(0, list.length - listH)));
						for (let i = rosterOffset; i < Math.min(list.length, rosterOffset + listH); i++) {
							const row = list[i]!, on = i === index;
							const marker = on ? fg256("peach", tc) + "▌" + FG_RESET : " ";
							if (row.kind === "new") {
								const text = fit(marker + " " + fg256("green", tc) + "＋" + FG_RESET + " 新建会话" + (pendingQuestion ? "（发送草稿）" : ""), width);
								rows.push(on ? selLine(text, width) : text + RESET);
								continue;
							}
							const entry = row.entry, last = entry.turns.at(-1);
							const state = rowState(entry);
							const when = stamp(last ? last.at : entry.created).slice(last && new Date(last.at).toDateString() === new Date().toDateString() ? 6 : 0);
							const role = entry.metadata?.modelRole ?? entry.controller?.spec ?? "";
							const tail = " " + statusDot(state, tc) + fg256("subtext0", tc) + " " + state + FG_RESET + " " +
								fg256("overlay0", tc) + when + (role ? " · " + role : "") + " · " + entry.turns.length + " 条" + FG_RESET;
							const text = fit(marker + " " + fit(title(entry), Math.max(1, width - 2 - visibleWidth(tail))) + tail, width);
							rows.push(on ? selLine(text, width) : text + RESET);
						}
						if (list.length === 1) rows.push(rosterFilter.trim() ? theme.fg("muted", "没有匹配「" + rosterFilter.trim() + "」的会话") : theme.fg("muted", "还没有 SIDE 会话；选中新建会话并按 Enter"));
					}
					while (rows.length < listH) rows.push("");
					if (rosterFiltering) rows.push(filterText(width));
					return rows.slice(0, Math.max(0, height));
				};
				/** Preview panel content: cached per (selected entry, turn version, dims) since it renders every frame. */
				let previewCache: { key: string; rows: string[] } | undefined;
				const previewBody = (width: number, height: number): string[] => {
					const entry = selectedId === NEW_ROW_ID ? undefined : rosterEntry();
					const last = entry?.turns.at(-1), ctl = entry?.controller;
					const key = [width, height, selectedId, loadState, pendingQuestion, pendingSpec,
						entry?.turns.length, last?.version, last?.status, last?.answer.length, ctl?.liveVersion,
						entry ? rowState(entry) : "", entry?.metadata?.modelRole ?? ctl?.spec].join("|");
					if (previewCache?.key === key) return previewCache.rows;
					const rows = previewBodyInner(width, height);
					previewCache = { key, rows };
					return rows;
				};
				const previewBodyInner = (width: number, height: number): string[] => {
					const rows: string[] = [];
					const dim = (s: string) => fg256("overlay0", tc) + s + FG_RESET;
					const sub = (s: string) => fg256("subtext0", tc) + s + FG_RESET;
					const centered = (s: string) => " ".repeat(Math.max(0, Math.floor((width - visibleWidth(s)) / 2))) + s;
					const inspect = () => { rows.push("", centered(dim("Select a session to inspect"))); };
					if (loadState === "loading") rows.push(dim("正在载入…"));
					else if (loadState === "error") rows.push(fg256("red", tc) + "读取失败" + FG_RESET, fit(dim(loadError), Math.max(1, width - 2)));
					else if (selectedId === NEW_ROW_ID) {
						if (pendingSpec || pendingQuestion) rows.push(sub("新会话"), " 角色 " + (pendingSpec ?? DEFAULT_MODEL),
							pendingQuestion ? fit(" 草稿 " + line(pendingQuestion), Math.max(1, width - 2)) : " 无待发草稿", "", dim(" Enter 创建并打开"));
						else inspect();
					} else {
						const entry = rosterEntry();
						if (!entry) inspect();
						else {
							const last = entry.turns.at(-1), state = rowState(entry);
							const role = entry.metadata?.modelRole ?? entry.controller?.spec ?? "";
							rows.push(fit(sub(title(entry)), width), " " + statusDot(state, tc) + " " + fg256("subtext0", tc) + state + FG_RESET +
								(role ? fg256("overlay0", tc) + " · " + role + FG_RESET : ""));
							rows.push(dim(" 创建 " + stamp(entry.created) + " · " + entry.turns.length + " 条"));
							if (entry.metadata?.snapshot?.at) rows.push(dim(" 快照 " + entry.metadata.snapshot.at));
							if (last) {
								rows.push("", " " + fg256("yellow", tc) + "问" + FG_RESET + " " + fit(line(last.question), Math.max(1, width - 4)),
									" " + fg256("teal", tc) + "答" + FG_RESET + " " + fit(line(last.answer || (last.status === "running" || last.status === "starting" ? "（等待回答）" : "（无回答）")), Math.max(1, width - 4)));
							} else rows.push("", dim(" 尚无问答 · Enter 打开并提问"));
						}
					}
					while (rows.length < height) rows.push("");
					return rows.slice(0, Math.max(0, height));
				};
				/** Turn-history panel content (no borders). */
				const historyBody = (c: SideController, width: number, height: number): string[] => {
					const rows: string[] = [];
					const v = c.view, index = c.selectedIndex();
					if (index < v.historyOffset) v.historyOffset = index;
					if (index >= v.historyOffset + height) v.historyOffset = index - height + 1;
					v.historyOffset = Math.max(0, Math.min(v.historyOffset, Math.max(0, c.turns.length - height)));
					if (!c.turns.length) rows.push(theme.fg("muted", "还没有 SIDE 问答"));
					for (let i = v.historyOffset; i < Math.min(c.turns.length, v.historyOffset + height); i++) {
						const turn = c.turns[i]!, on = i === index;
						const marker = on ? fg256("peach", tc) + "▌" + FG_RESET : " ";
						const tail = " " + statusDot(statusLabels[turn.status], tc) + fg256("subtext0", tc) + " " + statusLabels[turn.status] + FG_RESET;
						const text = fit(marker + " " + fg256("overlay0", tc) + (i + 1) + FG_RESET + " " +
							fit(line(turn.question), Math.max(1, width - 4 - visibleWidth(tail))) + tail, width);
						rows.push(on ? selLine(text, width) : text + RESET);
					}
					while (rows.length < height) rows.push("");
					return rows;
				};
				const auxiliaryBody = (c: SideController | undefined, width: number, height: number): string[] => {
					const lines: string[] = [];
					if (aux === "role") {
						const items = rolesNow();
						if (roleIndex < roleOffset) roleOffset = roleIndex;
						if (roleIndex >= roleOffset + height) roleOffset = roleIndex - height + 1;
						roleOffset = Math.max(0, Math.min(roleOffset, Math.max(0, items.length - height)));
						for (let i = roleOffset; i < Math.min(items.length, roleOffset + height); i++) {
							const item = items[i]!;
							const marker = i === roleIndex ? fg256("peach", tc) + "▌" + FG_RESET : " ";
							const text = fit(marker + " " + ("@" + item.id === c?.spec ? fg256("yellow", tc) + "*" + FG_RESET : " ") +
								" @" + item.id + fg256("overlay0", tc) + " · " + (item.model ?? item.unavailable) + FG_RESET, width);
							lines.push(i === roleIndex ? selLine(text, width) : text + RESET);
						}
						while (lines.length < height) lines.push("");
						return lines;
					}
					if (aux === "context") {
						const s = c?.snapshot;
						lines.push("SIDE 上下文: " + (c?.contextState ?? "无会话"));
						if (!s) lines.push("尚未导入主上下文；旧记录来源未知，首次提问建立新快照");
						else lines.push("main ID: " + s.mainSessionId, "leaf: " + (s.leaf ?? "无"), "时间: " + s.at,
							"主消息数: " + s.messages.length, "旁路消息数: " + (c?.turns.reduce((n, t) => n + (t.messages?.length ?? (t.answer ? 2 : 0)), 0) ?? 0),
							"继承系统指导: " + s.system.length + " 段", "来源: " + s.note);
						const usage = c?.session?.getContextUsage?.();
						if (usage && typeof usage.tokens === "number") lines.push("旁路上下文用量: " + usage.tokens + " tokens");
						const breakdown = c?.session?.getContextBreakdown?.();
						if (breakdown) lines.push("上下文分解: " + JSON.stringify(breakdown).slice(0, 200));
						if (s && currentCtx.sessionManager.getLeafId() !== s.leaf) lines.push("main 已推进；本 SIDE 保持旧快照，回列表新建可取得最新上下文");
						if (c?.contextError) lines.push("错误: " + c.contextError);
						lines.push("原生工具协议优先于历史路由描述", "逻辑工具: " + (c?.logicalTools.join(", ") || "未装载"),
							"直接入口: " + (c?.directTools.join(", ") || "未装载"), "桥接入口: " + (c?.bridgeTools.join(", ") || "未装载"));
					}
					const rendered = lines.flatMap(s => new Markdown(clean(s), 0, 0, getMarkdownTheme()).render(width));
					helpOffset = Math.max(0, Math.min(helpOffset, Math.max(0, rendered.length - height)));
					const out = rendered.slice(helpOffset, helpOffset + height);
					while (out.length < height) out.push("");
					return out;
				};
				const confirmBody = (c: SideController | undefined, width: number): string[] =>
					(confirmThread ? ["丢弃整个 SIDE 会话？", confirmThread.title, "先中断运行和待答交互，再删除全部历史；不可恢复", "已执行的工具修改不会撤销", "y丢弃 · n/Esc/Enter取消"] :
						["删除选中 SIDE 问答？", c?.selectedTurn()?.question ?? "", "仅删除本条；已执行工具修改不会撤销", "y删除 · n/Esc/Enter取消"])
						.map(s => fit(theme.fg("warning", clean(s)), width));
				/** Explicit actions replace printable shortcuts; opening the menu never changes the draft. */
				const actionItems = (c: SideController | undefined): { id: SideAction; label: string }[] => {
					if (showRoster && loadState !== "ready") return loadState === "error" ? [{ id: "retry", label: "重试读取历史" }] : [];
					const items: { id: SideAction; label: string }[] = [];
					const entry = showRoster ? rosterEntry() : selected();
					if (showRoster) items.push({ id: "new", label: "新建会话" }, { id: "filter", label: "筛选会话" });
					else if (c) {
						if (c.view.page === "chat") items.push({ id: "history", label: "选择历史问答" },
							{ id: "tools", label: c.view.toolsExpanded ? "折叠工具输出" : "展开工具输出" });
						if (c.selectedTurn()) items.push({ id: "copy", label: "回填第 " + (c.selectedIndex() + 1) + " 条回答到 MAIN 草稿" },
							{ id: "delete", label: "删除第 " + (c.selectedIndex() + 1) + " 条问答…" });
						if (c.view.page === "chat" && !c.view.followTail) items.push({ id: "latest", label: "回到最新回答并跟随" });
					}
					items.push({ id: "role", label: entry ? "选择模型角色" : "选择新会话模型角色" });
					if (entry) {
						items.push({ id: "context", label: "查看上下文" });
						if (entry.controller?.busy) items.push({ id: "cancel", label: "取消本次回答 · Ctrl+c" });
						items.push({ id: "close", label: "关闭会话并保留历史 · Ctrl+w" });
						if (showRoster) items.push({ id: "discard", label: "丢弃整个会话…" });
					}
					return items;
				};
				const runAction = (id: SideAction): void => {
					actions = undefined;
					const entry = showRoster ? rosterEntry() : selected(), c = entry ? controller(entry) : undefined;
					switch (id) {
						case "new": startNew(); break;
						case "filter": rosterFiltering = true; break;
						case "retry": reload(); break;
						case "history": if (c) c.view.page = "history"; break;
						case "copy": {
							const turn = c?.selectedTurn();
							if (turn?.answer.trim()) finish({ kind: "copy", text: turn.answer });
							else c?.setStatus("没有可复制的回答");
							break;
						}
						case "tools": if (c) { c.view.toolsExpanded = !c.view.toolsExpanded; c.view.timelineDirty = true; } break;
						case "role":
							aux = "role"; roleForNew = showRoster && !entry; roleOffset = 0;
							roleIndex = Math.max(0, rolesNow().findIndex(r => "@" + r.id === (roleForNew ? pendingSpec ?? DEFAULT_MODEL : c?.spec)));
							break;
						case "context": if (c) { aux = "context"; helpOffset = 0; } break;
						case "latest": if (c) { c.view.followTail = true; timeline.scrollToBottom(); syncAnchor(c); } break;
						case "delete":
							if (c?.busy || c?.deleting || c?.switching) c.setStatus("请先用 Ctrl+c 取消并等待收尾");
							else c?.setDeleteCandidate(c.selectedTurn()?.id);
							break;
						case "discard":
							if (c?.deleting || c?.switching) rosterStatus = "SIDE 正在关闭或丢弃，请等待收尾";
							else if (entry) confirmThread = { id: entry.id, ids: entry.turns.map(t => t.id), title: title(entry) };
							break;
						case "cancel": c?.cancelRequest(); break;
						case "close":
							if (c) void c.closeSession().then(() => { rosterStatus = "已关闭 SIDE；历史已保留"; }, error => { rosterStatus = errorText(error); }).finally(poke);
							showRoster = true; aux = undefined; confirmThread = undefined;
							break;
					}
					repaint();
				};
				/** Compact action picker: no chord timers, printable triggers, or hidden command mode. */
				const actionDrawer = (width: number, height: number): string[] => {
					if (!actions?.length) return [];
					actionIndex = Math.max(0, Math.min(actionIndex, actions.length - 1));
					actionPageSize = Math.min(actions.length, Math.max(1, Math.min(8, height - 2)));
					const start = Math.min(Math.floor(actionIndex / actionPageSize) * actionPageSize, Math.max(0, actions.length - actionPageSize));
					const rows: string[] = [];
					if (height > 2) rows.push(fit(theme.fg("accent", "SIDE 操作 · " + (actionIndex + 1) + "/" + actions.length), width));
					for (let i = start; i < start + actionPageSize; i++) {
						const item = actions[i]!, on = i === actionIndex;
						const text = fit((on ? "▌ " : "  ") + theme.fg(item.id === "delete" || item.id === "discard" ? "warning" : "text", item.label), width);
						rows.push(on ? selLine(text, width) : text);
					}
					if (height > 1) rows.push(fit(theme.fg("dim", "↑↓选择 · Enter执行 · Esc返回"), width));
					return rows;
				};
				/** The editor itself is the open line immediately beneath the status band. */
				const composerInput = (editorRows: readonly string[], width: number): string[] => editorRows.map((row, index) => {
					const prefix = index === 0 ? fg256("lavender", tc) + BOX.bl + BOX.h + FG_RESET + " " : "   ";
					return prefix + truncateToWidth(row, Math.max(1, width - 3));
				});
				return {
					render(width): readonly string[] {
						const rT0 = performance.now();
						const height = Math.max(1, tui.terminal.rows), compact = height < 10;
						const now = new Date(), clock = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
						const tickKey = width + "x" + height + "@" + clock;
						if (viewTick === paintedTick && lastKey === tickKey && lastLines) return lastLines;
						const entry = showRoster && !aux ? undefined : selected(), c = entry ? controller(entry) : undefined;
						const status = line(compact && pendingQuestion && showRoster ? "草稿: " + pendingQuestion : c?.status ?? rosterStatus);
						const short = loadState === "loading" ? "载入中" : loadState === "error" ? "读取失败" :
							!showRoster && c ? (c.deleting ? "删除中" : c.closing ? "关闭中" : c.busy ? "回答中" : c.switching ? "切换中" : c.turns.at(-1) ? statusLabels[c.turns.at(-1)!.status] : "就绪") :
							threads.size ? "就绪" : "空";
						const usage = c?.session?.getContextUsage?.();
						const ctxTotal = usage && typeof usage.contextWindow === "number" && usage.contextWindow > 0 ? usage.contextWindow : undefined;
						const tokens = usage && typeof usage.tokens === "number" && usage.tokens > 0 ? (usage.tokens >= 1000 ? (usage.tokens / 1000).toFixed(1) + "k" : String(usage.tokens)) : "";
						const pct = usage && typeof usage.percent === "number" && Number.isFinite(usage.percent) ? usage.percent :
							usage && typeof usage.tokens === "number" && ctxTotal ? usage.tokens / ctxTotal * 100 : undefined;
						const hover = showRoster ? rosterEntry() : undefined;
						const spec = c?.spec ?? hover?.metadata?.modelRole ?? hover?.controller?.spec ?? pendingSpec ?? "";
						const modelName = c?.session?.model?.id ?? spec.replace(/^@/, "");
						const cwdShort = (() => {
							const home = process.env.HOME ?? "";
							let p = home && (cwd === home || cwd.startsWith(home + "/")) ? "~" + cwd.slice(home.length) : cwd;
							const parts = p.split("/");
							if (parts.length > 3) p = parts.map((s, i) => i > 0 && i < parts.length - 1 && s.length > 1 ? s[0] : s).join("/");
							return p;
						})();
						const hhmm = clock;
						const left: BarSeg[] = [
							{ text: (showRoster ? ICON.agents + " 会话列表" : ICON.ghost + " " + (entry ? title(entry) : "会话列表")), fg: "yellow", flex: true },
							{ text: modelName ? ICON.model + " " + modelName : "", fg: "pink" },
							{ text: rosterFiltering ? "FILTER" : "", fg: "yellow", drop: 1 },
							{ text: ICON.folder + " " + cwdShort, fg: "teal", drop: 1 },
							{ text: ICON.session + " " + mainSessionId.slice(0, 8), fg: "lavender", drop: 2 },
						];
						const right: BarSeg[] = [
							{ text: tokens ? ICON.tokens + " " + tokens : "", fg: "green", drop: 1 },
							{ text: ICON.dot + " " + short, fg: stateColor(short) },
							{ text: "F1 操作", fg: "overlay0", drop: 2 },
							{ text: ICON.time + " " + hhmm, fg: "rosewater", drop: 3 },
						];
						const hintPairs = (): readonly (readonly [string, string])[] =>
							confirmThread || c?.deleteCandidateId ? [["y", "删除"], ["Esc/Enter", "取消"]] :
							aux === "role" ? [["↑/↓", "选择"], ["Enter", "确认"], ["Esc", "返回"]] :
							aux ? [["↑/↓", "滚动"], ["PgUp/PgDn", "翻页"], ["Esc", "返回"]] :
							rosterFiltering ? [["Enter", "确认筛选"], ["Esc", "清空"]] :
							showRoster && loadState === "error" ? [["Enter", "重试"], ["Esc", "返回"]] :
							showRoster ? [["↑/↓", "选择"], ["Enter", "打开"], ["Del", "丢弃"], ["F1", "操作"], ["Esc", "隐藏"]] :
							c?.view.page === "history" ? [["↑/↓", "选择"], ["Enter", "跳转"], ["Del", "删除"], ["F1", "操作"], ["Esc", "对话"]] :
							[["Enter", "发送"], ["PgUp/PgDn", "滚动"], ["F1", "操作"], ["Ctrl+c", "取消"], ["Ctrl+w", "关闭"], ["Esc", "列表"]];
						const exitHint = confirmThread || c?.deleteCandidateId ? "y删除·Esc取消" : aux ? "Esc返回" :
							rosterFiltering ? "Esc清空" : showRoster ? "F1操作·Esc退出" : "F1操作·Esc列表";
						const chatPage = !!c && !aux && c.view.page === "chat";
						if (c) {
							c.view.editor.setMaxHeight(compact ? 1 : Math.max(1, Math.min(6, Math.floor(height / 4))));
							c.view.editor.setBorderVisible(false);
							c.view.editor.focused = chatPage && !actions && !confirmThread && !c.deleteCandidateId;
						}
						const keepExit = (s: string, tailText: string): string => {
							const headW = Math.max(1, width - visibleWidth(tailText) - 1);
							return fit(s, headW) + (visibleWidth(s) <= headW ? " · " : "·") + tailText;
						};
						const chrome = compact ? [fit(theme.fg("dim", keepExit("SIDE" + (rosterFiltering ? "·FILTER" : "") + "·" + status, exitHint)), width)] : [];
						// The status band is the composer's upper edge; its first input row begins with ╰─.
						const tail: string[] = [];
						const composerRows = chatPage && !(confirmThread || c?.deleteCandidateId) ? c!.view.editor.render(Math.max(1, width - 3)) : [];
						const showComposer = composerRows.length > 0 && (compact ? composerRows.length + 3 <= height : composerRows.length + 7 <= height);
						if (compact) {
							// rosterBody already appends its own filter row; only chat owns the input row.
							const barText = showRoster ? "会话列表" : entry ? title(entry) : "SIDE";
							tail.push(fit(theme.fg("dim", keepExit(barText + " · " + short, hhmm)), width));
							if (showComposer) tail.push(...composerInput(composerRows, width));
						} else {
							if (status) tail.push(fit(theme.fg(/失败|错误/.test(status) ? "error" : "muted", status), width));
							if (pendingQuestion && showRoster) tail.push(fit(fg256("peach", tc) + "草稿: " + line(pendingQuestion), width) + RESET);
							tail.push(hintLine(hintPairs(), width, tc));
							tail.push(statusBar(width, left, right, { pct, total: ctxTotal }, tc));
							if (showComposer) tail.push(...composerInput(composerRows, width));
						}
						const bodyHeight = Math.max(1, height - chrome.length - tail.length);
						lastHeight = Math.max(1, compact ? bodyHeight : bodyHeight - 2);
						if (c) c.view.editor.focused = chatPage && showComposer && !actions && !confirmThread && !c.deleteCandidateId;
						composerVisible = !!c && chatPage && showComposer && !confirmThread && !c.deleteCandidateId;
						let body: string[];
						if (compact) {
							if (confirmThread || c?.deleteCandidateId) body = confirmBody(c, width);
							else if (aux) body = auxiliaryBody(c, width, bodyHeight);
							else if (showRoster) body = rosterBody(width, bodyHeight);
							else if (c?.view.page === "history") body = historyBody(c, width, bodyHeight);
							else if (c) {
								const switched = renderedId !== c.threadId;
								if (ensureTimeline(c, width, compact) || switched || !synced) { const atTail = timeline.getScrollOffset() === timeline.getMaxScrollOffset(); timeline.setLines(c.view.timelineLines); synced = true; if (atTail && c.view.followTail) timeline.scrollToBottom(); }
								renderedId = c.threadId; timeline.setHeight(bodyHeight);
								if (restoreScroll || switched) { if (c.view.followTail) timeline.scrollToBottom(); else timeline.setScrollOffset(anchorOffset(c)); restoreScroll = false; }
								else if (c.view.followTail) timeline.scrollToBottom(); else timeline.setScrollOffset(anchorOffset(c));
								body = timeline.render(width);
							} else body = [];
						} else if (confirmThread || c?.deleteCandidateId) {
							body = panelLines("删除确认", "lavender", confirmBody(c, width - 3), width, bodyHeight, tc);
						} else if (aux) {
							body = panelLines(aux === "role" ? "角色" : "上下文", "lavender",
								auxiliaryBody(c, width - 3, bodyHeight - 2), width, bodyHeight, tc);
						} else if (showRoster) {
							if (width >= 80) {
								const lw = Math.max(28, Math.min(width - 24, Math.round(width * 0.4))), rw = width - lw - 1;
								const lp = panelLines("会话列表", "lavender", rosterBody(lw - 3, bodyHeight - 2), lw, bodyHeight, tc);
								const rp = panelLines("预览", "surface0", previewBody(rw - 3, bodyHeight - 2), rw, bodyHeight, tc);
								body = lp.map((l, i) => l + " " + (rp[i] ?? ""));
							} else {
								body = panelLines("会话列表", "lavender", rosterBody(width - 3, bodyHeight - 2), width, bodyHeight, tc);
							}
						} else if (c?.view.page === "history") {
							body = panelLines("历史", "lavender", historyBody(c, width - 3, bodyHeight - 2), width, bodyHeight, tc);
						} else if (c) {
							const timelineH = bodyHeight;
							const switched = renderedId !== c.threadId;
							if (ensureTimeline(c, width - 3, compact) || switched || !synced) { const atTail = timeline.getScrollOffset() === timeline.getMaxScrollOffset(); timeline.setLines(c.view.timelineLines); synced = true; if (atTail && c.view.followTail) timeline.scrollToBottom(); }
							renderedId = c.threadId; timeline.setHeight(Math.max(1, timelineH - 2));
							if (restoreScroll || switched) { if (c.view.followTail) timeline.scrollToBottom(); else timeline.setScrollOffset(anchorOffset(c)); restoreScroll = false; }
							else if (c.view.followTail) timeline.scrollToBottom(); else timeline.setScrollOffset(anchorOffset(c));
							const inner = timeline.render(width - 3);
							body = panelLines("对话", "blue", inner, width, timelineH, tc);
						} else body = panelLines("SIDE", "surface0", [], width, bodyHeight, tc);
						const underlying = [...chrome, ...body].slice(0, Math.max(0, height - tail.length)).concat(tail).slice(0, height);
						const drawer = actions ? actionDrawer(width, height) : [];
						const rows = drawer.length ? underlying.slice(0, Math.max(0, height - drawer.length)).concat(drawer) : underlying;
						paintedTick = viewTick; lastKey = tickKey; lastLines = rows;
						perfLog("render " + tickKey + " body=" + (performance.now() - rT0).toFixed(2) + "ms");
						return rows;
					},
					invalidate() { lastLines = undefined; timeline.invalidate();
						for (const entry of threads.values()) { entry.controller?.view.blockCache.clear(); if (entry.controller) entry.controller.view.timelineDirty = true; }
						for (const component of toolComponents.values()) component.invalidate(); },
					dispose() { finished = true; timeline.dispose(); for (const component of toolComponents.values()) component.dispose(); toolComponents.clear(); },
					handleInput(data: string) {
						if (creationPromise) { if (matchesKey(data, "escape")) finish({ kind: "return" }); return; }
						const c = active(), enter = matchesKey(data, "enter") || data === "\r" || data === "\n", esc = matchesKey(data, "escape");
						if (confirmThread || c?.deleteCandidateId) {
							const candidate = confirmThread;
							if (data === "y" || data === "Y") { confirmThread = undefined; if (candidate) deleteThread(candidate); else if (c?.deleteCandidateId) void c.deleteTurn(c.deleteCandidateId); }
							else if (data === "n" || data === "N" || esc || enter) { confirmThread = undefined; c?.setDeleteCandidate(undefined); }
							repaint(); return;
						}
						if (matchesKey(data, "ctrl+w")) { runAction("close"); return; }
						if (matchesKey(data, "ctrl+c") && (c?.busy || showRoster && rosterEntry()?.controller?.busy)) { runAction("cancel"); return; }
						if (actions) {
							if (esc || matchesKey(data, "f1")) actions = undefined;
							else if (enter) { const item = actions[actionIndex]; if (item) runAction(item.id); }
							else if (matchesKey(data, "up")) actionIndex = Math.max(0, actionIndex - 1);
							else if (matchesKey(data, "down")) actionIndex = Math.min(actions.length - 1, actionIndex + 1);
							else if (matchesKey(data, "pageUp")) actionIndex = Math.max(0, actionIndex - actionPageSize);
							else if (matchesKey(data, "pageDown")) actionIndex = Math.min(actions.length - 1, actionIndex + actionPageSize);
							else if (matchesKey(data, "home")) actionIndex = 0;
							else if (matchesKey(data, "end")) actionIndex = actions.length - 1;
							repaint(); return;
						}
						const page = Math.max(1, lastHeight - 1);
						const step = matchesKey(data, "down") ? 1 : matchesKey(data, "up") ? -1 : matchesKey(data, "pageDown") ? page : matchesKey(data, "pageUp") ? -page : 0;
						if (aux) {
							if (esc) { aux = undefined; roleForNew = false; }
							else if (aux === "role") {
								const items = rolesNow();
								if (step) roleIndex = Math.max(0, Math.min(items.length - 1, roleIndex + step));
								else if (matchesKey(data, "home")) roleIndex = 0;
								else if (matchesKey(data, "end")) roleIndex = Math.max(0, items.length - 1);
								else if (enter) {
									const item = items[roleIndex];
									if (item?.unavailable) { if (c) c.setStatus("角色不可用：" + item.unavailable); else rosterStatus = "角色不可用：" + item.unavailable; }
									else if (item && roleForNew) { pendingSpec = "@" + item.id; draftBlocked = false; rosterStatus = "待发角色 @" + item.id; }
									else if (item && c) { draftBlocked = false; void c.switchModel("@" + item.id).then(repaint); }
									aux = undefined; roleForNew = false;
								}
							} else {
								if (step) helpOffset = Math.max(0, helpOffset + step);
								else if (matchesKey(data, "home")) helpOffset = 0;
								else if (matchesKey(data, "end")) helpOffset = Number.MAX_SAFE_INTEGER;
							}
							repaint(); return;
						}
						if (matchesKey(data, "f1")) { const items = actionItems(c); if (items.length) { actions = items; actionIndex = 0; } repaint(); return; }
						if (rosterFiltering && showRoster) {
							if (esc) { rosterFilter = ""; rosterFiltering = false; }
							else if (enter) rosterFiltering = false;
							else if (matchesKey(data, "backspace")) rosterFilter = Array.from(rosterFilter).slice(0, -1).join("");
							else if (data.length === 1 && data >= " " && data !== "\x7f") rosterFilter += data;
							else if (data.length > 1 && !data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(data)) rosterFilter += data;
							repaint(); return;
						}
						if (esc) {
							if (showRoster) finish({ kind: "return" });
							else if (c?.view.page === "history") c.view.page = "chat";
							else showRoster = true;
							repaint(); return;
						}
						if (showRoster) {
							if (loadState === "error" && enter) reload();
							else if (loadState === "ready") {
								if (step) rosterSelect(rosterIndex() + step);
								else if (matchesKey(data, "home")) rosterSelect(0);
								else if (matchesKey(data, "end")) rosterSelect(rosterRows().length - 1);
								else if (matchesKey(data, "delete")) runAction("discard");
								else if (enter) { const row = rosterRows()[rosterIndex()]; if (row?.kind === "new") startNew(); else if (row) openEntry(row.entry, false); }
							}
						} else if (c?.view.page === "history") {
							if (step) c.selectByIndex(c.selectedIndex() + step);
							else if (matchesKey(data, "home")) c.selectByIndex(0);
							else if (matchesKey(data, "end")) c.selectByIndex(c.turns.length - 1);
							else if (matchesKey(data, "delete")) runAction("delete");
							else if (enter) { const turn = c.selectedTurn(); if (turn) { c.view.page = "chat"; c.view.followTail = false; c.view.scrollAnchor = { turnId: turn.id, offset: 0 }; restoreScroll = true; } }
						} else if (c) {
							if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) { c.view.followTail = false; timeline.scroll(step); syncAnchor(c); }
							// Empty input is still input: letters, punctuation, paste and editor navigation never become commands.
							else if (composerVisible) c.view.editor.handleInput(data);
							else c.setStatus("终端太小，输入不可用；F1 操作或 Esc 返回");
						}
						repaint();
					},
				};
			}, { overlay: true, overlayOptions: { fullscreen: true, anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, mouseTracking: false } });
			if (mount?.token === token) mount = undefined;
			if (!exit || exit.kind === "return") {
				if (pendingQuestion) try { openCtx.ui.notify("SIDE 草稿已保留：" + line(pendingQuestion).slice(0, 80) + "；下次 /side 打开列表可继续发送。", "info"); } catch { /* notify best-effort */ }
				return;
			}
			if (exit.kind === "copy") { openCtx.ui.setEditorText(exit.text); openCtx.ui.notify("SIDE 回答已放入 main 草稿，尚未发送。", "info"); return; }
		}
	};
	reload();
	return { mainSessionId, cwd, open, detachView, disposeManager };
}
export default function sideExtension(pi: ExtensionAPI): void {
	let manager: SideManager | undefined;
	const retired = new Set<Promise<void>>();
	const retire = (old: SideManager | undefined) => {
		if (!old) return;
		const promise = old.disposeManager(); retired.add(promise);
		promise.finally(() => retired.delete(promise));
	};
	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent.kind === "main" && ctx.hasUI && ctx.mode === "tui") {
			const ui = mainSession(ctx).extensionRunner?.getUIContext();
			if (ui) uiArbiter(ui);
		}
	});
	pi.on("session_switch", () => { retire(manager); manager = undefined; });
	pi.on("session_shutdown", async () => { const current = manager; manager = undefined; retire(current); await Promise.all([...retired]); });
	pi.registerCommand("side", {
		description: "独立 SIDE；/side [--model @role] [问题]；F1 操作，Esc 隐藏，Ctrl+w 关闭",
		handler: async (args, ctx) => {
			if (ctx.agent.kind !== "main") { ctx.ui.notify("禁止从 SIDE 或子代理再创建 SIDE。", "error"); return; }
			if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify("/side 需要交互式 OMP 终端视图。", "warning"); return; }
			let parsed: ParsedArgs;
			try { parsed = parseArgs(args); } catch (error) { ctx.ui.notify(errorText(error), "error"); return; }
			const id = ctx.sessionManager.getSessionId();
			if (manager && (manager.mainSessionId !== id || manager.cwd !== ctx.cwd)) { retire(manager); manager = undefined; }
			if (!manager) {
				try { manager = createSideManager(ctx, historyDirectory(id)); }
				catch (error) { ctx.ui.notify("SIDE 初始化失败：" + errorText(error), "error"); return; }
			}
			await manager.open(ctx, parsed);
		},
	});
}
