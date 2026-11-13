import { describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { formatBytes } from "../../src/frontend/ui/format";
import {
  card,
  fakeApi,
  locales,
  makeRunbook,
  makeStep,
  openRunbook,
  useRenderedApp,
} from "./helpers";

useRenderedApp();

const runbook = makeRunbook(
  [
    makeStep({ id: 1, title: "Make config", status: "done" }),
    makeStep({
      id: 2,
      title: "Apply config",
      command: "apply -",
      resolvedCommand: "apply -",
      stdin: {
        source: { from: "step", step: 1, stream: "stdout" },
        bytes: 1229,
        preview: "listen 443;\n",
        problem: null,
      },
    }),
    makeStep({
      id: 3,
      title: "Log in",
      command: "login --password-stdin",
      resolvedCommand: "login --password-stdin",
      stdin: {
        source: { from: "secret", name: "api_token" },
        bytes: null,
        preview: null,
        problem: null,
      },
    }),
  ],
  { title: "Deploy", nextStepId: 2, secretsAvailable: true },
);

const api = () =>
  fakeApi({
    detail: runbook,
    post: async () => ({ data: { id: 40, status: "running" } }),
  });

const open = (client: ReturnType<typeof api>) =>
  openRunbook(client, { title: "Deploy", shows: "Apply config" });

describe("standard input in the UI", () => {
  it("says where the input comes from, never a secret", async () => {
    await open(api());
    expect(card(2).querySelector("[data-stdin]")!.textContent).toBe(
      "Standard input: output of step 1 (stdout, 1.2 KB)",
    );
    expect(card(3).querySelector("[data-stdin]")!.textContent).toBe(
      "Standard input: secret api_token (hidden)",
    );
  });

  it("disables Send to terminal with the reason", async () => {
    await open(api());
    const send = within(card(2))
      .getByText(locales.step.send)
      .closest("button")!;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe(
      "This step gets input from output of step 1 (stdout): use Run",
    );
    expect(card(2).querySelector("[data-send-refused]")!.textContent).toBe(
      "This step gets input from output of step 1 (stdout): use Run",
    );
    const run = within(card(2)).getByText(locales.step.run).closest("button")!;
    expect(run.disabled).toBe(false);
  });

  it("shows the source and the first characters in the Run confirm", async () => {
    const client = api();
    await open(client);
    fireEvent.click(within(card(2)).getByText(locales.step.run));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.querySelector("[data-confirm-stdin]")!.textContent).toBe(
      "Standard input: output of step 1 (stdout, 1.2 KB)",
    );
    expect(
      dialog.querySelector("[data-confirm-stdin-preview]")!.textContent,
    ).toBe("listen 443;\n");
  });

  it("shows no preview for a secret, and warns what the command gets", async () => {
    await open(api());
    fireEvent.click(within(card(3)).getByText(locales.step.run));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.querySelector("[data-confirm-stdin]")!.textContent).toBe(
      `Standard input: secret api_token (hidden) ${locales.stdin.secretWarning}`,
    );
    expect(dialog.querySelector("[data-confirm-stdin-preview]")).toBeNull();
  });

  it("formats sizes", () => {
    expect(formatBytes(7)).toBe("7 B");
    expect(formatBytes(1229)).toBe("1.2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
