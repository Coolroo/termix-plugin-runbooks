/**
 * Limits the server checks and the page shows before it sends anything.
 * Shared by the server and the UI.
 */

/** The longest note a person may send with a step to the agent. */
export const MAX_SENT_NOTE = 500;

/** The most a person may type into a running command at once (1.4.6). */
export const MAX_TYPED_BYTES = 4096;

/**
 * Hidden input this long or longer is hidden in the run's output as
 * [secret:typed] (1.4.6). A shorter one (y, a PIN) would hide that text
 * everywhere in the output.
 */
export const MIN_HIDDEN_CHARS = 4;

/**
 * The most Mark done takes as a terminal run's output, in characters; what
 * Send to terminal reads from the terminal is cut to it (1.4.10).
 */
export const MAX_PASTED_CHARS = 262_144;

/** A step's time limit when it gives none, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 120_000;
