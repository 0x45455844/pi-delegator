import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TRANSCRIPT_DIR_ENV,
  createTranscript,
  defaultTranscriptDir,
  transcriptDirectory,
  transcriptFileName,
} from "../src/transcript.ts";

function withTempDir(fn) {
  const directory = mkdtempSync(join(tmpdir(), "pi-delegator-transcript-"));
  try {
    return fn(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the transcript directory is the option, then the environment, then the agent default", () => {
  assert.equal(transcriptDirectory("/tmp/opts", { [TRANSCRIPT_DIR_ENV]: "/tmp/env" }), "/tmp/opts");
  assert.equal(transcriptDirectory(undefined, { [TRANSCRIPT_DIR_ENV]: "/tmp/env" }), "/tmp/env");
  assert.equal(transcriptDirectory(undefined, {}), defaultTranscriptDir());
  // The default is under the agent directory, never in the repository the run works on.
  assert.ok(defaultTranscriptDir().endsWith(join("logs", "delegate")), defaultTranscriptDir());
  // An empty value from either source is the switch off, not a relative path.
  assert.equal(transcriptDirectory("  ", { [TRANSCRIPT_DIR_ENV]: "/tmp/env" }), undefined);
  assert.equal(transcriptDirectory(undefined, { [TRANSCRIPT_DIR_ENV]: "" }), undefined);
});

test("run names sort chronologically and carry the role", () => {
  const first = transcriptFileName("reviewer", new Date("2026-11-22T06:12:03.482Z"), 4812);
  const second = transcriptFileName("reviewer", new Date("2026-11-22T06:12:04.100Z"), 4812);
  assert.equal(first, "20261122T061203.482Z-4812-reviewer.jsonl");
  assert.ok(first < second);
  // A role name reaches a filename; a path separator must not survive it.
  assert.equal(transcriptFileName("../../evil", new Date("2026-11-22T06:12:03.482Z"), 1), "20261122T061203.482Z-1-..-..-evil.jsonl");
});

test("a transcript is created on the first byte and private", () => {
  withTempDir((root) => {
    const directory = join(root, "delegate");
    const handle = createTranscript(directory, "run.jsonl");
    assert.equal(existsSync(handle.path), false);
    handle.write(Buffer.from('{"type":"session"}\n'));
    assert.equal(existsSync(handle.path), true);
    assert.equal(statSync(handle.path).mode & 0o777, 0o600);
    handle.write(Buffer.from('{"type":"agent_settled"}\n'));
    assert.equal(handle.close(), handle.path);
    assert.equal(
      readFileSync(handle.path, "utf8"),
      '{"type":"session"}\n{"type":"agent_settled"}\n',
    );
  });
});

test("a transcript that never wrote a byte names nothing, and a taken name is not clobbered", () => {
  withTempDir((root) => {
    const quiet = createTranscript(root, "quiet.jsonl");
    assert.equal(quiet.close(), undefined);
    assert.equal(existsSync(quiet.path), false);

    // An open that succeeded but wrote nothing is not a transcript a card may name.
    const named = [];
    const empty = createTranscript(root, "empty.jsonl", (path) => named.push(path));
    empty.write(Buffer.alloc(0));
    assert.deepEqual(named, []);
    assert.equal(empty.close(), undefined);

    writeFileSync(join(root, "taken.jsonl"), "previous run\n");
    const collision = createTranscript(root, "taken.jsonl");
    collision.write(Buffer.from("mine\n"));
    // `wx` refuses the existing file: this run loses its tee, the earlier one keeps its evidence.
    assert.equal(collision.close(), undefined);
    assert.equal(readFileSync(join(root, "taken.jsonl"), "utf8"), "previous run\n");
  });
});

test("a broken tee is dropped once and never fails the writer", () => {
  withTempDir((root) => {
    // A file where the directory should be makes every open fail.
    writeFileSync(join(root, "blocked"), "");
    const handle = createTranscript(join(root, "blocked", "run.jsonl"), "run.jsonl");
    assert.doesNotThrow(() => {
      handle.write(Buffer.from("first\n"));
      handle.write(Buffer.from("second\n"));
    });
    assert.equal(handle.close(), undefined);
  });
});
