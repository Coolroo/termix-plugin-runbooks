import { describe, expect, it } from "vitest";
import { isSshHost } from "../../../src/shared/hosts";

describe("isSshHost", () => {
  it("follows the SSH switch, then the connection type", () => {
    expect(isSshHost({ enableSsh: true, connectionType: "rdp" })).toBe(true);
    expect(isSshHost({ enableSsh: false, connectionType: "ssh" })).toBe(false);
    expect(isSshHost({ enableSsh: 1 })).toBe(true);
    expect(isSshHost({ enableSsh: 0 })).toBe(false);
    expect(isSshHost({ connectionType: "vnc" })).toBe(false);
    expect(isSshHost({ connectionType: "ssh" })).toBe(true);
    expect(isSshHost({})).toBe(true);
    expect(isSshHost(null)).toBe(false);
  });
});
