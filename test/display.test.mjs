import assert from "node:assert/strict";
import test from "node:test";
import { compactDisplayText, formatProgress, renderProgress, terminalSafe, toolStartLabel } from "../src/display.ts";

const start = (toolName, args = {}) => ({ type: "tool_start", toolName, args });
const message = (text) => ({ type: "assistant_message", text });
const state = () => ({ totalCalls: 0, recentTools: [] });
const usageOf = (turns, contextTokens, cost = 0) => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost, contextTokens, turns,
});
// The runner attaches Pi's counters to every progress event; these fixtures state
// them explicitly so a test says which turn it is standing in.
const started = (toolName, args, usage) => ({ type: "tool_start", toolName, args, usage });

test("bash commands preserve shell syntax while remaining compact and terminal-safe", () => {
  assert.equal(toolStartLabel("bash", { command: "cd app &&\n pnpm test | tee result.txt" }, "/repo"), "bash cd app && pnpm test | tee result.txt");
  assert.equal(toolStartLabel("bash", { command: "/custom/tool --flag '$VALUE'" }, "/repo"), "bash /custom/tool --flag '$VALUE'");
  assert.equal(toolStartLabel("bash", { command: "\x1b[31mprintf\x1b[0m hi\u202e" }, "/repo"), "bash printf hi");
  assert.equal(toolStartLabel("bash", { command: "😀".repeat(500) }, "/repo"), `bash ${"😀".repeat(240)}…`);
  for (const args of [null, [], "command", {}, { command: 10 }, { command: " \n\t" }]) {
    assert.equal(toolStartLabel("bash", args, "/repo"), "bash");
  }
  const summary = state();
  const progress = formatProgress(start("bash", { command: "cd app && npm test" }), summary, "/repo");
  assert.match(progress, /→ bash cd app && npm test/);
  assert.match(renderProgress(summary, true), /→ bash cd app && npm test/);
});

test("labels expose bounded path targets and bash commands", () => {
  for (const name of ["read", "grep", "find", "ls", "edit", "write"]) {
    assert.equal(toolStartLabel(name, { path: "/repo/src/file.ts", pattern: "secret", command: "secret", content: "secret" }, "/repo"), `${name} src/file.ts`);
  }
  assert.equal(toolStartLabel("read", { path: "src/file.ts", offset: 20 }, "/repo"), "read src/file.ts:20");
  assert.equal(toolStartLabel("read", { path: ".", offset: -1 }, "/repo"), "read .");
  assert.equal(toolStartLabel("grep", { pattern: "secret" }, "/repo"), "grep");
  assert.equal(toolStartLabel("unknown", { path: "secret", command: "secret" }, "/repo"), "unknown");
  assert.equal(toolStartLabel("bash", { command: "npm test -- --runInBand" }, "/repo"), "bash npm test -- --runInBand");
  assert.equal(toolStartLabel("bash", { command: "curl -H 'Authorization: secret'" }, "/repo"), "bash curl -H 'Authorization: secret'");
  for (const args of [null, [], "secret", { path: 10 }]) assert.equal(toolStartLabel("read", args, "/repo"), "read");
  assert.equal(Array.from(toolStartLabel("write", { path: "😀".repeat(500) }, "/repo")).length, 167);
});

test("all display inputs remove terminal commands, controls, bidi and normalize whitespace", () => {
  const hostile = "\x1b[31mred\x1b[0m\x1b]8;;https://secret\x07link\x1b]8;;\x07\x00\x08\u202e\n next";
  assert.equal(compactDisplayText(hostile, 100), "redlink next");
  assert.equal(terminalSafe(hostile), "redlink\n next");
  assert.equal(toolStartLabel("\x1b[31munknown\x1b[0m", {}, "/repo"), "unknown");
  assert.equal(toolStartLabel("read", { path: "src/\x1b[31mfile\x1b[0m\u202e" }, "/repo"), "read src/file");
  assert.equal(compactDisplayText("😀".repeat(300), 240), `${"😀".repeat(240)}…`);
});

test("recent starts are not compressed or completion claims; commentary persists and states isolate", () => {
  const a = state();
  const b = state();
  formatProgress(message("Inspecting\n files"), a, "/repo");
  for (let i = 0; i < 8; i++) formatProgress(start("read", { path: `file${i}` }), a, "/repo");
  assert.equal(formatProgress(message(undefined), a, "/repo"), "Recent tool starts · 8 total · 4 earlier\n· read file4\n· read file5\n· read file6\n→ read file7\n\nLatest commentary: Inspecting files");
  assert.equal(renderProgress(a, true), "Recent tool starts · 8 total\n· read file0\n· read file1\n· read file2\n· read file3\n· read file4\n· read file5\n· read file6\n→ read file7\n\nLatest commentary: Inspecting files");
  assert.equal(a.recentTools.length, 8);
  formatProgress(start("read", { path: "file8" }), a, "/repo");
  const text = formatProgress(message(" \n "), a, "/repo");
  assert.equal(text, "Recent tool starts · 9 total · 5 earlier\n· read file5\n· read file6\n· read file7\n→ read file8\n\nLatest commentary: Inspecting files");
  assert.equal(renderProgress(a, true), "Recent tool starts · 9 total · 1 earlier\n· read file1\n· read file2\n· read file3\n· read file4\n· read file5\n· read file6\n· read file7\n→ read file8\n\nLatest commentary: Inspecting files");
  assert.equal(a.recentTools.length, 8);
  assert.equal(formatProgress(start("ls", { path: "." }), b, "/other"), "Recent tool starts · 1 total\n→ ls .");
  assert.equal(formatProgress(message(undefined), b, "/other"), "Recent tool starts · 1 total\n→ ls .");
  assert.equal(renderProgress(b, true), "Recent tool starts · 1 total\n→ ls .");
  assert.equal(a.totalCalls, 9);
});

test("collapsed and expanded boundaries count earlier starts against displayed rows without mutation", () => {
  const summary = state();
  assert.equal(renderProgress(summary), "No tool starts yet");
  assert.equal(renderProgress(summary, true), "No tool starts yet");
  for (let count = 1; count <= 10; count++) {
    const collapsed = formatProgress(start("read", { path: "same" }), summary, "/repo");
    const snapshot = structuredClone(summary);
    for (const expanded of [false, true]) {
      const visible = Math.min(count, expanded ? 8 : 4);
      const earlier = count - visible;
      const expected = [
        `Recent tool starts · ${count} total${earlier ? ` · ${earlier} earlier` : ""}`,
        ...Array.from({ length: visible }, (_, index) => index === visible - 1
          ? `→ read same${count > 1 ? ` ×${count}` : ""}`
          : "· read same"),
      ].join("\n");
      assert.equal(renderProgress(summary, expanded), expected);
      if (!expanded) assert.equal(collapsed, expected);
    }
    assert.deepEqual(summary, snapshot);
    assert.equal(summary.recentTools.length, Math.min(count, 8));
  }
});

test("the card carries the run's counters and the streak of a repeated call", () => {
  const summary = state();
  const loop = { command: "git show 714bcdc:strata-up | sed -n '520,530p'" };

  // Nothing is invented before the child reports counters: turn one's first tool
  // start carries zeros, and a card that said "0 turns" would read as a dead run.
  assert.equal(
    formatProgress(started("bash", loop, usageOf(0, 0)), summary, "/repo"),
    "Recent tool starts · 1 total\n→ bash git show 714bcdc:strata-up | sed -n '520,530p'",
  );

  formatProgress(started("bash", loop, usageOf(12, 61_000)), summary, "/repo");
  const card = formatProgress(started("bash", loop, usageOf(14, 83_800)), summary, "/repo");
  assert.match(card, /^Recent tool starts · 3 total · 14 turns · ctx 83\.8k$/m);
  assert.match(card, /→ bash git show 714bcdc:strata-up \| sed -n '520,530p' ×3$/m);
  // A local engine bills nothing, so a cost of zero carries no information.
  assert.doesNotMatch(card, /\$/);

  // A different call ends the streak; the counters keep their own line of history.
  const next = formatProgress(started("read", { path: "src/x.ts" }, usageOf(15, 84_100)), summary, "/repo");
  assert.doesNotMatch(next, /×/);
  assert.match(next, /ctx 84\.1k/);

  // Token counts stay readable at every size, and a real cost is worth naming.
  assert.match(formatProgress(started("ls", { path: "." }, usageOf(1, 940)), state(), "/repo"), /ctx 940$/m);
  const paid = formatProgress(started("ls", { path: "." }, usageOf(2, 1_234_000, 0.42)), state(), "/repo");
  assert.match(paid, /1\.2M/);
  assert.match(paid, /\$0\.42/);
  // Singular, because a person reads this line.
  assert.match(formatProgress(started("ls", { path: "." }, usageOf(1, 1_000)), state(), "/repo"), /· 1 turn · ctx 1k$/m);

  // Commentary refreshes the counters too, and rendering still mutates nothing.
  formatProgress({ type: "assistant_message", text: "still looking", usage: usageOf(16, 85_000) }, summary, "/repo");
  assert.match(renderProgress(summary), /16 turns/);
  const snapshot = structuredClone(summary);
  renderProgress(summary, true);
  assert.deepEqual(summary, snapshot);
});
