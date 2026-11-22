import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * The child runs with `--no-session`, and the reason is not that its output is
 * disposable: the JSONL on its stdout IS the transcript, and the parent is its
 * only reader, so a Pi session file would advertise a run that cannot be
 * resumed. Keeping the flag without keeping the stream, though, threw the
 * transcript away with the pipe — answering "what is that run looping on"
 * mid-flight took `ps`, `lsof`, and reading the runner to learn the flag
 * existed. This module is the tee: the same bytes the parser consumes, on disk,
 * named on the card while the run is still going.
 *
 * Files hold raw child output (task text, tool arguments, model commentary), so
 * they are written `0600` and land under the agent directory, never in the
 * repository the delegate works on.
 */
export const TRANSCRIPT_DIR_ENV = "PI_DELEGATOR_TRANSCRIPT_DIR";

export function defaultTranscriptDir(): string {
  return join(getAgentDir(), "logs", "delegate");
}

/** Directory to write transcripts into: option, then environment, then default. Empty disables the tee. */
export function transcriptDirectory(option: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (option !== undefined) return option.trim() === "" ? undefined : option;
  const fromEnv = env[TRANSCRIPT_DIR_ENV];
  if (fromEnv === undefined) return defaultTranscriptDir();
  const trimmed = fromEnv.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * One name per run: sortable, and readable at a glance in a directory two boxes
 * may share. The session-local `run-N` a background run is collected by restarts
 * at 1 in every session, so it cannot name a file two sessions will both write;
 * a UTC stamp with milliseconds, plus a pid, can. `wx` refuses to clobber, so a
 * collision costs that run its tee rather than another run's transcript.
 */
export function transcriptFileName(profileName: string, now: Date, pid: number): string {
  const stamp = now.toISOString().replace(/[-:]/gu, "");
  const role = profileName.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 32) || "run";
  return `${stamp}-${pid}-${role}.jsonl`;
}

export interface TranscriptHandle {
  /** The path this handle writes to, whether or not the file exists yet. */
  readonly path: string;
  /** Append one raw chunk of child stdout. Never throws: a log is not worth a run. */
  write(chunk: Buffer): void;
  /** Close the file, and report the path only when a byte was actually written. */
  close(): string | undefined;
}

/**
 * A lazily created append-only transcript. Nothing is created until the child
 * emits a byte, so a run that failed to launch claims no file, and the first byte
 * on disk is what `onPath` reports — a card that points at an empty file sends a
 * reader to nothing.
 */
export function createTranscript(
  directory: string,
  name: string,
  onPath?: (path: string) => void,
): TranscriptHandle {
  const path = join(directory, name);
  let fd: number | undefined;
  let written = false;
  let broken = false;
  return {
    path,
    write(chunk: Buffer): void {
      if (broken) return;
      try {
        if (fd === undefined) {
          mkdirSync(directory, { recursive: true });
          fd = openSync(path, "wx", 0o600);
        }
        if (writeSync(fd, chunk) > 0 && !written) {
          written = true;
          onPath?.(path);
        }
      } catch {
        // Diagnostics never decide the run: an unwritable directory, a name
        // already taken, a full disk — drop the tee for good rather than
        // retrying the same failure on every chunk the child produces.
        broken = true;
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            // The descriptor is already unusable; nothing left to close.
          }
          fd = undefined;
        }
      }
    },
    close(): string | undefined {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Already closed by the platform; the file on disk is what it is.
        }
        fd = undefined;
      }
      return written ? path : undefined;
    },
  };
}
