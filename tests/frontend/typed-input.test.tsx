import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import type { CurrentUser } from "@termix-ssh/plugin-sdk/frontend";
import { looksLikePrompt } from "../../src/frontend/running/RunInput";
import type { Run, Step } from "../../src/frontend/api-types";
import {
  card,
  fakeApi,
  locales,
  makeRun,
  makeRunbook,
  makeStep,
  openRunbook,
  useRenderedApp,
  type FakeApi,
} from "./helpers";

// Who is signed in: unknown (null) unless a test says.
const viewer = vi.hoisted(() => ({ user: null as CurrentUser | null }));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<typeof import("@termix-ssh/plugin-sdk/frontend")>()),
  useCurrentUser: () => viewer.user,
}));

useRenderedApp();

const text = locales.run.input;

/** One step whose run is running (or as `run` says). */
function server(
  run: Partial<Run> = {},
  step: Partial<Step> = {},
  answer: (body: Record<string, unknown>) => unknown = () => ({ data: {} }),
) {
  const state = { run: { ...run } };
  const runbook = () =>
    makeRunbook(
      [
        makeStep({
          id: 2,
          position: 1,
          title: "Become root",
          command: "sudo true",
          resolvedCommand: "sudo true",
          status: "pending",
          ...step,
          runs: [
            makeRun({
              id: 21,
              stepId: 2,
              status: "running",
              command: "sudo true",
              finishedAt: null,
              exitCode: null,
              stdout: "starting\n",
              running: true,
              acceptsInput: true,
              elapsedMs: 30_000,
              silentMs: 0,
              ...state.run,
            }),
          ],
        }),
      ],
      { title: "Deploy", nextStepId: 2 },
    );
  const client = fakeApi({
    detail: runbook,
    post: async (_url, body) => answer(body as Record<string, unknown>),
  });
  return { state, client };
}

async function open(client: FakeApi) {
  await openRunbook(client, {
    title: "Deploy",
    shows: () => screen.findAllByText("Become root"),
  });
  return card(2);
}

const line = (element: HTMLElement) =>
  element.querySelector("[data-run-input]") as HTMLElement | null;
const field = (element: HTMLElement) =>
  element.querySelector("[data-input-text]") as HTMLInputElement;

describe("the input line (T-023)", () => {
  it("shows under a running command; Enter sends the line and clears the box", async () => {
    viewer.user = null;
    const { client } = server();
    const element = await open(client);
    expect(line(element)!.getAttribute("data-run-input")).toBe("open");
    expect(within(element).getByText(text.label)).toBeTruthy();
    // Not a prompt: what is typed shows, and the time left is there.
    expect(field(element).getAttribute("data-hidden")).toBe("false");
    expect(element.querySelector("[data-time-left]")!.textContent).toMatch(
      /^1:3\d left before the time limit$/,
    );
    fireEvent.change(field(element), { target: { value: "yes" } });
    fireEvent.keyDown(field(element), { key: "Enter" });
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/runs/21/input", {
        text: "yes\n",
        hidden: false,
      }),
    );
    await vi.waitFor(() => expect(field(element).value).toBe(""));
  });

  it("lights up and hides what is typed when the output asks for a password", async () => {
    viewer.user = null;
    const { client } = server({
      stdout: "",
      stderr: "[sudo] password for alice: ",
    });
    const element = await open(client);
    expect(line(element)!.hasAttribute("data-prompt")).toBe(true);
    expect(within(element).getByText(text.prompt)).toBeTruthy();
    expect(field(element).getAttribute("data-hidden")).toBe("true");
    expect(within(element).getByText(text.hiddenHint, { exact: false }));
    // A short text is hidden here, not in the output: the line says so.
    fireEvent.change(field(element), { target: { value: "pw" } });
    expect(within(element).getByText(text.hiddenShort, { exact: false }));
    fireEvent.change(field(element), { target: { value: "hunter22" } });
    fireEvent.click(within(element).getByText(text.send));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/runs/21/input", {
        text: "hunter22\n",
        hidden: true,
      }),
    );
    // The eye shows it again.
    fireEvent.click(element.querySelector("[data-input-eye]")!);
    expect(field(element).getAttribute("data-hidden")).toBe("false");
  });

  it("starts hidden on an interactive step, which has an Interactive chip", async () => {
    viewer.user = null;
    const { client } = server({}, { interactive: true });
    const element = await open(client);
    expect(
      element.querySelector('[data-mark="interactive"]')!.textContent,
    ).toBe(locales.kind.mark.interactive);
    expect(field(element).getAttribute("data-hidden")).toBe("true");
  });

  it("ends the line with CR on an interactive step, as a terminal's Enter does (BUG-010)", async () => {
    viewer.user = null;
    const { client } = server({}, { interactive: true });
    const element = await open(client);
    fireEvent.change(field(element), { target: { value: "become-pw" } });
    fireEvent.keyDown(field(element), { key: "Enter" });
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/runs/21/input", {
        text: "become-pw\r",
        hidden: true,
      }),
    );
  });

  it("End input sends what is in the box and ends the input", async () => {
    viewer.user = null;
    const { state, client } = server({}, {}, (body) => {
      if (body.end) {
        state.run = {
          acceptsInput: false,
          inputs: [{ at: "x", chars: 0, hidden: false, ended: true }],
        };
      }
      return { data: {} };
    });
    const element = await open(client);
    fireEvent.click(within(element).getByText(text.end));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/runs/21/input", {
        text: "",
        hidden: false,
        end: true,
      }),
    );
    await vi.waitFor(() =>
      expect(line(element)!.getAttribute("data-run-input")).toBe("ended"),
    );
    expect(within(element).getByText(text.ended)).toBeTruthy();
    expect(within(element).getByText("Typed into once (never stored)"));
  });

  it("tells another person who can type, and offers no line (D6)", async () => {
    viewer.user = { userId: "bob", username: "bob", isAdmin: false };
    const { client } = server();
    const element = await open(client);
    expect(line(element)!.getAttribute("data-run-input")).toBe("not-yours");
    expect(
      within(element).getByText(
        "Only alice, who started this run, can type into it.",
      ),
    ).toBeTruthy();
    expect(field(element)).toBeNull();
    viewer.user = null;
  });

  it("shows no line for a run that got stdin, or one that ended", async () => {
    viewer.user = { userId: "alice", username: "alice", isAdmin: false };
    const { client } = server({
      acceptsInput: false,
      stdin: { from: "value", name: "v", bytes: 3 },
    });
    const element = await open(client);
    expect(line(element)).toBeNull();
    viewer.user = null;
  });
});

describe("looksLikePrompt", () => {
  it("reads the last line of stdout and of stderr", () => {
    const yes = [
      "[sudo] password for alice: ",
      "Enter passphrase for key '/root/.ssh/id_ed25519': ",
      "BECOME password:",
      "ok\nVault password (default): ",
      "Token: ",
      "PIN:",
    ];
    for (const stdout of yes) {
      expect(looksLikePrompt({ stdout, stderr: "" }), stdout).toBe(true);
    }
    expect(looksLikePrompt({ stdout: "", stderr: yes[0] })).toBe(true);
    const no = [
      "password: changed\n",
      "Building tokens:\nstep 1",
      "Continue? [y/N] ",
      "spinning: ",
      "",
    ];
    for (const stdout of no) {
      expect(looksLikePrompt({ stdout, stderr: null }), stdout).toBe(false);
    }
  });
});
