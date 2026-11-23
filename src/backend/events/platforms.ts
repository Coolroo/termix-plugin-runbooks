/**
 * Which hosts are Windows hosts (1.4.10, phase 3), so the Linux-only events
 * (container, unit, log, job, a file with sudo) are refused when a step is
 * written, as the owner asked. Termix tells a plugin nothing about a host's
 * system, so Runbooks knows it two ways:
 *
 * - A host whose Termix tags include "windows": the token's copy of its
 *   hosts keeps it (windows: true) when a person saves the token's hosts.
 * - A host whose SSH server said it is Windows in a run: each event check
 *   reads the server's version string ("OpenSSH_for_Windows_9.5"), which
 *   ssh2 keeps from the handshake, so no command runs for it. Runbooks
 *   remembers it here until Termix restarts.
 *
 * A host not known either way is checked when it runs: a Linux-only event
 * on a Windows host fails at once, with words that say why.
 */

export type Platforms = ReturnType<typeof createPlatforms>;

export function createPlatforms() {
  const seen = new Map<number, "windows" | "other">();
  return {
    /** What a run found the host to be. */
    note(hostId: number, platform: "windows" | "other" | null): void {
      if (platform) seen.set(hostId, platform);
    },
    /** Whether a run found the host to be a Windows host. */
    isWindows(hostId: number): boolean {
      return seen.get(hostId) === "windows";
    },
  };
}

/** Whether a host's Termix tags (comma-separated) name it a Windows host. */
export function windowsTagged(tags: string | null | undefined): boolean {
  return (tags ?? "")
    .split(",")
    .some((tag) => tag.trim().toLowerCase() === "windows");
}
