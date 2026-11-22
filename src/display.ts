import { relative, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { DelegateProgress } from "./runner.ts";
import type { UsageSummary } from "./protocol.ts";

const RECENT_TOOL_LIMIT = 8;

/** Remove terminal commands and invisible controls; preserve ordinary output line breaks. */
export function terminalSafe(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, "");
}

export function compactDisplayText(text: string, limit: number): string {
  const normalized = terminalSafe(text).replace(/\s+/gu, " ").trim();
  const points = Array.from(normalized);
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : normalized;
}

export interface ProgressSummary {
  totalCalls: number;
  readonly recentTools: string[];
  latestAssistantText?: string;
  /**
   * Pi's own counters as of the most recent progress event. Absent until the child
   * reports a turn: printing zeros would read as a run that did nothing, and every
   * local engine bills 0 whatever it burns.
   */
  usage?: UsageSummary;
  /**
   * How many tool starts in a row carried the newest label. A delegate that repeats
   * one command forever is the failure nobody is watching, and the label is the only
   * thing the card has to notice it with — so two commands that truncate to the same
   * display string count as one streak, which is what a reader would see anyway.
   */
  repeatStreak?: number;
}

function formatTokenCount(tokens: number): string {
  const trim = (text: string): string => text.replace(/\.0$/u, "");
  // Bucket on the value that will be printed, not the raw one: 999,950 rounds to
  // "1.0" at one decimal, and a card reading `ctx 1000k` contradicts its own units.
  if (tokens >= 999_950) return `${trim((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${trim((tokens / 1_000).toFixed(1))}k`;
  return `${tokens}`;
}

/**
 * Money, or nothing. A cost that rounds to zero says no more than no cost does, so
 * it is omitted rather than printed as `$0.000` — and trailing zeros go, because a
 * card is read at a glance.
 */
function formatCost(cost: number): string {
  const digits = (cost >= 0.01 ? cost.toFixed(2) : cost.toFixed(3)).replace(/0+$/u, "").replace(/\.$/u, "");
  return digits === "0" ? "" : `$${digits}`;
}

/** What the run is costing, in the order a watcher reads it: effort, then size, then money. */
function formatCounters(usage: UsageSummary | undefined): string {
  if (usage === undefined) return "";
  const parts: string[] = [];
  if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.contextTokens > 0) parts.push(`ctx ${formatTokenCount(usage.contextTokens)}`);
  if (usage.cost > 0) {
    const cost = formatCost(usage.cost);
    if (cost !== "") parts.push(cost);
  }
  return parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
}

export function toolStartLabel(toolName: string, args: unknown, cwd: string): string {
  const name = compactDisplayText(toolName, 12);
  const record = typeof args === "object" && args !== null && !Array.isArray(args)
    ? args as Record<string, unknown> : {};
  if (toolName === "bash") {
    const command = typeof record.command === "string" ? compactDisplayText(record.command, 240) : "";
    return command ? `${name} ${command}` : name;
  }
  if (!["read", "grep", "find", "ls", "edit", "write"].includes(toolName)) return name;
  const path = typeof record.path === "string" && record.path.trim() ? record.path : undefined;
  const target = path === undefined ? undefined : compactDisplayText(relative(cwd, resolve(cwd, path)) || ".", 160);
  const offset = toolName === "read" && Number.isSafeInteger(record.offset) && (record.offset as number) > 0
    ? `:${record.offset}` : "";
  return target ? `${name} ${target}${offset}` : name;
}

export function formatProgress(progress: DelegateProgress, summary: ProgressSummary, cwd: string): string {
  if (progress.usage !== undefined) summary.usage = { ...progress.usage };
  if (progress.type === "tool_start") {
    const label = toolStartLabel(progress.toolName, progress.args, cwd);
    const repeated = label === summary.recentTools.at(-1);
    summary.totalCalls += 1;
    summary.recentTools.push(label);
    if (summary.recentTools.length > RECENT_TOOL_LIMIT) summary.recentTools.shift();
    summary.repeatStreak = repeated ? (summary.repeatStreak ?? 0) + 1 : 1;
  } else if (progress.text !== undefined) {
    const text = compactDisplayText(progress.text, 240);
    if (text) summary.latestAssistantText = text;
  }
  return renderProgress(summary);
}

/** Format retained progress without changing it. */
export function renderProgress(summary: ProgressSummary, expanded = false): string {
  const displayedTools = summary.recentTools.slice(expanded ? -RECENT_TOOL_LIMIT : -4);
  const earlier = summary.totalCalls - displayedTools.length;
  const heading = summary.totalCalls === 0
    ? "No tool starts yet"
    : `Recent tool starts · ${summary.totalCalls} total${earlier > 0 ? ` · ${earlier} earlier` : ""}${formatCounters(summary.usage)}`;
  const rows = displayedTools.map((label, index) => {
    const newest = index === displayedTools.length - 1;
    const streak = newest ? summary.repeatStreak ?? 0 : 0;
    return `${newest ? "→" : "·"} ${label}${streak > 1 ? ` ×${streak}` : ""}`;
  });
  if (summary.latestAssistantText !== undefined) rows.push("", `Latest commentary: ${summary.latestAssistantText}`);
  return [heading, ...rows].join("\n");
}
