/**
 * Runbooks never acts as a user it names (T-032): no users:impersonate in
 * the manifest, and no backend code that calls ctx.asUser or issues a user
 * token. Agents read HAW's VMs from the copy a token keeps (1.4.7); a token
 * saved before that has no copy, and says so.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { manifest, pluginDir } from "./helpers";
import { listVms, vmHostIds } from "../../src/backend/agents/ops/vms";
import type { AgentCaller } from "../../src/backend/agents/ops/access";
import type { TokenHost } from "../../src/backend/runbooks/store/types";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe("no impersonation", () => {
  it("does not ask for users:impersonate", () => {
    expect(manifest.capabilities).not.toContain("users:impersonate");
  });

  it("has no backend code that acts as a named user", () => {
    const files = sources(join(pluginDir, "src", "backend"));
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .filter(({ text }) => /\basUser\b|\bissueUserToken\b/.test(text)),
    );
    expect(found).toEqual([]);
  });
});

describe("a token saved before 1.4.7", () => {
  const caller = (hosts: TokenHost[]): AgentCaller =>
    ({ token: { hosts } }) as unknown as AgentCaller;
  const old = caller([
    { id: 1, name: "host-1", address: "10.0.0.1", folder: null, ssh: true },
  ]);

  it("has no copy, so the card checks a VM step's host", async () => {
    expect(await vmHostIds(old)).toBeNull();
  });

  it("tells the agent to have its hosts saved again", async () => {
    await expect(listVms(old, {})).rejects.toThrow(
      /saves the token's hosts again/,
    );
  });
});
