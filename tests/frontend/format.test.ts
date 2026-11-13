import { describe, expect, it } from "vitest";
import {
  formatTime,
  hostLabel,
  runSummaryKey,
} from "../../src/frontend/ui/format";

const t = (key: string, options?: Record<string, unknown>) =>
  `${key}${options ? JSON.stringify(options) : ""}`;

describe("hostLabel", () => {
  it("names the host, or says it is not available", () => {
    expect(hostLabel(t, { hostId: 1, hostName: "web-1" })).toBe("web-1");
    expect(hostLabel(t, { hostId: 4, hostName: null })).toBe(
      'step.unknownHost{"id":4}',
    );
  });
});

describe("formatTime", () => {
  it("keeps a text that is not a time", () => {
    expect(formatTime(null)).toBe("");
    expect(formatTime("soon")).toBe("soon");
  });
});

describe("runSummaryKey", () => {
  it("picks the line by how the run ran and ended", () => {
    const key = (
      mode: Parameters<typeof runSummaryKey>[0]["mode"],
      status: Parameters<typeof runSummaryKey>[0]["status"] = "done",
      how?: "made" | "saved",
    ) =>
      runSummaryKey({
        mode,
        status,
        secrets: how
          ? {
              used: [],
              captured: [],
              made: {
                name: "x",
                how,
                store: "runbook",
                where: null,
                expiresAt: null,
              },
            }
          : null,
      });
    expect(key("secret", "done", "made")).toBe("run.secretMade");
    expect(key("secret", "done", "saved")).toBe("run.secretSaved");
    expect(key("manual")).toBe("run.manualDone");
    expect(key("manual", "failed")).toBe("run.manualFailed");
    expect(key("outside")).toBe("run.outsideDone");
    expect(key("outside", "failed")).toBe("run.outsideFailed");
    expect(key("agent")).toBe("run.agentDone");
    expect(key("agent", "failed")).toBe("run.agentFailed");
    expect(key("exec", "failed")).toBe("run.byExec");
    expect(key("terminal", "awaiting-output")).toBe("run.byTerminal");
  });
});
