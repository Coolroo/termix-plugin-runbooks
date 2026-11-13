import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { formatDuration } from "../../src/frontend/ui/format";
import {
  card,
  fakeApi,
  flush,
  locales,
  makeRun,
  makeRunbook,
  makeStep,
  openRunbook,
  useRenderedApp,
  type FakeApi,
} from "./helpers";

useRenderedApp();

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
  const runbook = () =>
    makeRunbook(
      [
        makeStep({
          id: 2,
          position: 1,
          title: "Build",
          command: "make",
          resolvedCommand: "make",
          commandHash: "b".repeat(64),
          status: state.running ? "pending" : "done",
          runs: [
            makeRun({
              id: 21,
              stepId: 2,
              status: state.running ? "running" : "done",
              command: "make",
              commandHash: "b".repeat(64),
              startedAt: new Date(state.started).toISOString(),
              finishedAt: null,
              exitCode: state.running ? null : 0,
              stdout: state.stdout,
              running: state.running,
              lastOutputAt: new Date(state.lastOutput).toISOString(),
              elapsedMs: state.running ? Date.now() - state.started : null,
              silentMs: state.running ? Date.now() - state.lastOutput : null,
            }),
          ],
        }),
      ],
      {
        title: "Deploy",
        progress: { done: 0, failed: 0, total: 1 },
        nextStepId: 2,
      },
    );
  const client = fakeApi({
    detail: runbook,
    post: async () => ({ data: {} }),
  });
  return { state, client };
}

async function open(client: FakeApi, fake = false) {
  await openRunbook(client, {
    title: "Deploy",
    fakeTimers: fake,
    shows: () => screen.findByText("building 1/3", { exact: false }),
  });
  return card(2);
}

const detailCalls = (client: FakeApi) =>
  client.get.mock.calls.filter(([url]) => url === "/runbooks/7").length;

describe("a running step", () => {
  it("shows the output as it grows, the elapsed time and the silence", async () => {
    vi.useFakeTimers();
    const { state, client } = server();
    const card = await open(client, true);

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
    const card = await open(client);
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
