import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import { formatDuration } from "../../src/frontend/StepCard";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await rendered?.deactivate();
  rendered = null;
});

const summary = {
  id: 7,
  title: "Deploy",
  status: "open",
  createdBy: "lead",
  createdAt: "2026-11-07T10:00:00.000Z",
  updatedAt: "2026-11-07T10:05:00.000Z",
  revision: 4,
  progress: { done: 0, failed: 0, total: 1 },
};

/**
 * The server side of one running command: its output grows when told to,
 * and the silence and elapsed counts follow the (fake) clock.
 */
function server() {
  const state = {
    stdout: "building 1/3\n",
    lastOutput: Date.now(),
    started: Date.now() - 60_000,
    running: true,
  };
  const runbook = () => ({
    ...summary,
    summary: "",
    values: {},
    effectiveValues: [],
    nextStepId: 2,
    steps: [
      {
        id: 2,
        runbookId: 7,
        position: 1,
        title: "Build",
        body: "",
        hostId: 1,
        hostName: "web-1",
        command: "make",
        resolvedCommand: "make",
        commandHash: "b".repeat(64),
        missing: [],
        expect: "",
        captures: [],
        hideOutputFromAgents: false,
        status: state.running ? "pending" : "done",
        skipReason: null,
        ownerNote: "",
        timeoutMs: null,
        revision: 1,
        runs: [
          {
            id: 21,
            stepId: 2,
            runbookId: 7,
            mode: "exec",
            status: state.running ? "running" : "done",
            hostId: 1,
            command: "make",
            commandHash: "b".repeat(64),
            userId: "alice",
            startedAt: new Date(state.started).toISOString(),
            finishedAt: null,
            exitCode: state.running ? null : 0,
            stdout: state.stdout,
            stderr: "",
            truncated: false,
            timedOut: false,
            pastedOutput: null,
            error: null,
            captured: {},
            running: state.running,
            lastOutputAt: new Date(state.lastOutput).toISOString(),
            elapsedMs: state.running ? Date.now() - state.started : null,
            silentMs: state.running ? Date.now() - state.lastOutput : null,
          },
        ],
      },
    ],
  });
  const client = {
    get: vi.fn(async (url: string) => ({
      data: url === "/runbooks" ? [summary] : runbook(),
    })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return { state, client };
}

/** Lets promises and due timers run under fake timers. */
const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

async function openRunbook(client: unknown, fake = false) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api: client as never,
  });
  rendered.renderTab("runbooks", { isVisible: true });
  if (fake) {
    await flush();
    fireEvent.click(screen.getByText("Deploy"));
    await flush();
  } else {
    fireEvent.click(await screen.findByText("Deploy"));
    await screen.findByText("building 1/3", { exact: false });
  }
  return document.querySelector('[data-step="2"]') as HTMLElement;
}

const detailCalls = (client: { get: ReturnType<typeof vi.fn> }) =>
  client.get.mock.calls.filter(([url]) => url === "/runbooks/7").length;

describe("a running step", () => {
  it("shows the output as it grows, the elapsed time and the silence", async () => {
    vi.useFakeTimers();
    const { state, client } = server();
    const card = await openRunbook(client, true);

    const output = card.querySelector(
      `[data-live-output="${locales.run.stdout}"]`,
    ) as HTMLElement;
    expect(output.textContent).toBe("building 1/3\n");
    expect(card.querySelector("[data-elapsed]")!.textContent).toMatch(
      /^Running for 1:0\d$/,
    );
    // The person cannot start it again while it runs.
    expect(
      (
        within(card)
          .getByText(locales.step.run)
          .closest("button") as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    // Output keeps coming: read every second.
    const before = detailCalls(client);
    state.stdout += "building 2/3\n";
    state.lastOutput = Date.now();
    await flush(1000);
    expect(detailCalls(client)).toBe(before + 1);
    expect(output.textContent).toBe("building 1/3\nbuilding 2/3\n");

    // Then nothing for a while: a plain note, then a warning at 30 s.
    await flush(10_000);
    let silence = card.querySelector("[data-silence]") as HTMLElement;
    expect(silence.getAttribute("data-silence")).toBe("ok");
    // The last output came 1 s before these 10.
    expect(silence.textContent).toBe("No output for 11s");
    await flush(18_000);
    silence = card.querySelector("[data-silence]") as HTMLElement;
    expect(silence.getAttribute("data-silence")).toBe("ok");
    await flush(1000);
    silence = card.querySelector("[data-silence]") as HTMLElement;
    expect(silence.getAttribute("data-silence")).toBe("warn");
    expect(silence.textContent).toBe("No output for 30s");

    // It ends: the run shows as done, and the polling slows to 5 s.
    state.running = false;
    await flush(1000);
    expect(card.querySelector("[data-live-run]")).toBeNull();
    const pres = [...card.querySelectorAll("pre")].map(
      (pre) => pre.textContent,
    );
    expect(pres).toContain("building 1/3\nbuilding 2/3\n");
    const ended = detailCalls(client);
    await flush(4000);
    expect(detailCalls(client)).toBe(ended);
    await flush(1000);
    expect(detailCalls(client)).toBe(ended + 1);
  });

  it("stops the command after a confirm", async () => {
    const { client } = server();
    const card = await openRunbook(client);
    fireEvent.click(within(card).getByText(locales.step.stop));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Stop step 1?")).toBeTruthy();
    expect(client.post).not.toHaveBeenCalled();
    const confirmButton = within(dialog)
      .getAllByRole("button")
      .find((button) => button.textContent?.startsWith(locales.stop.confirm))!;
    fireEvent.click(confirmButton);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/2/stop"),
    );
  });
});

describe("formatDuration", () => {
  it("writes minutes and seconds, and hours when there are some", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });
});
