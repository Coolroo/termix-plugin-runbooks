import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import { formatBytes } from "../../src/frontend/StepCard";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
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
  progress: { done: 1, failed: 0, total: 3 },
};

function step(overrides: Record<string, unknown>) {
  return {
    runbookId: 7,
    body: "",
    hostId: 1,
    hostName: "web-1",
    command: "true",
    resolvedCommand: "true",
    commandHash: "a".repeat(64),
    missing: [],
    expect: "",
    captures: [],
    checks: [],
    hideOutputFromAgents: false,
    status: "pending",
    skipReason: null,
    ownerNote: "",
    timeoutMs: null,
    revision: 1,
    runs: [],
    wait: null,
    stdin: null,
    ...overrides,
  };
}

const runbook = {
  ...summary,
  summary: "",
  values: {},
  effectiveValues: [],
  nextStepId: 2,
  secretsAvailable: true,
  steps: [
    step({ id: 1, position: 1, title: "Make config", status: "done" }),
    step({
      id: 2,
      position: 2,
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
    step({
      id: 3,
      position: 3,
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
};

function api() {
  return {
    get: vi.fn(async (url: string) => ({
      data: url === "/runbooks" ? [summary] : runbook,
    })),
    post: vi.fn(async () => ({ data: { id: 40, status: "running" } })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

async function open(client: ReturnType<typeof api>) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api: client as never,
  });
  rendered.renderTab("runbooks", { isVisible: true });
  fireEvent.click(await screen.findByText("Deploy"));
  await screen.findByText("Apply config");
}

const card = (id: number) =>
  document.querySelector(`[data-step="${id}"]`) as HTMLElement;

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
