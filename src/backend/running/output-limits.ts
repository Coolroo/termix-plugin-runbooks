/**
 * How much output a sequence run keeps (BUG-022 M2). A wait or a retried
 * item may make 500 attempts of up to 256 KB per stream each, and a run
 * may have 20 such items: kept whole, one run could hold gigabytes, in
 * Termix's memory on SQLite. So:
 *
 * - The last attempt of an item keeps its whole output (256 KB per stream
 *   at most, as any command): it is the attempt that passed, or the one
 *   the item ended on. The item holds a copy of it.
 * - An earlier attempt keeps the last 4 KB of each stream once the next
 *   attempt starts, with its exit code, checks, state and why; truncated
 *   is then true.
 * - The earlier attempts of one item keep 256 KB of output together;
 *   attempts after that keep none.
 * - A run keeps 8 MB of attempt and item output; past that, an attempt or
 *   item keeps only the last 4 KB of each stream.
 *
 * The views read attempts without output; one attempt's output is read on
 * request (GET /runs/{id}/attempts/{attemptId}, and the agent's attempt
 * route and get_attempt).
 */

export const OUTPUT_LIMITS = {
  /** Bytes of each stream an earlier attempt keeps. */
  earlierTail: 4 * 1024,
  /** Bytes the earlier attempts of one item keep together. */
  itemEarlier: 256 * 1024,
  /** Bytes of output one run keeps, its attempts and items. */
  run: 8 * 1024 * 1024,
} as const;

/** The size of a text in bytes. */
export function bytesOf(text: string | null | undefined): number {
  return text ? Buffer.byteLength(text, "utf8") : 0;
}

/** The last `max` bytes of a text, cut at a character; and whether it cut. */
export function tailOf(
  text: string | null,
  max: number,
): { text: string | null; cut: boolean } {
  if (text === null) return { text, cut: false };
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { text, cut: false };
  if (max <= 0) return { text: "", cut: true };
  return {
    text: bytes
      .subarray(bytes.length - max)
      .toString("utf8")
      .replace(/^�+/, ""),
    cut: true,
  };
}

/** What a run may still keep: output is taken from it, and given back. */
export class OutputBudget {
  private left: number;

  constructor(total: number = OUTPUT_LIMITS.run) {
    this.left = total;
  }

  /**
   * The output to store: whole while the run has room, else the last 4 KB
   * of each stream. `cut` says it was cut here.
   */
  take(
    stdout: string | null,
    stderr: string | null,
  ): { stdout: string | null; stderr: string | null; cut: boolean } {
    const size = bytesOf(stdout) + bytesOf(stderr);
    if (size <= this.left) {
      this.left -= size;
      return { stdout, stderr, cut: false };
    }
    const out = tailOf(stdout, OUTPUT_LIMITS.earlierTail);
    const err = tailOf(stderr, OUTPUT_LIMITS.earlierTail);
    this.left = Math.max(0, this.left - bytesOf(out.text) - bytesOf(err.text));
    return { stdout: out.text, stderr: err.text, cut: out.cut || err.cut };
  }

  /** Output that was stored and is cut now: the run has that room again. */
  giveBack(bytes: number): void {
    this.left += Math.max(0, bytes);
  }
}
