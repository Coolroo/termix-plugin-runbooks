import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
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
  title: "Tokens",
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

const run = {
  id: 21,
  stepId: 1,
  runbookId: 7,
  mode: "exec",
  status: "done",
  hostId: 1,
  command: "make-token",
  commandHash: "a".repeat(64),
  userId: "alice",
  startedAt: "2026-11-07T10:01:00.000Z",
  finishedAt: "2026-11-07T10:01:01.000Z",
  exitCode: 0,
  stdout: "token: [secret:api_token]\n",
  stderr: "",
  truncated: false,
  timedOut: false,
  pastedOutput: null,
  error: null,
  captured: {},
  running: false,
  stdin: null,
  secrets: {
    used: [],
    captured: [{ name: "api_token", expiresAt: "2026-11-14T10:01:01.000Z" }],
  },
};

function runbook(overrides: Record<string, unknown> = {}) {
  return {
    ...summary,
    summary: "",
    values: {},
    effectiveValues: [],
    nextStepId: 2,
    secretsAvailable: true,
    secrets: [
      {
        name: "api_token",
        step: 1,
        set: true,
        expiresAt: "2026-11-14T10:01:01.000Z",
      },
      { name: "db_password", step: 2, set: false, expiresAt: null },
    ],
    steps: [
      step({
        id: 1,
        position: 1,
        title: "Make token",
        status: "done",
        secretCaptures: [{ name: "api_token", pattern: "token: (\\S+)" }],
        runs: [run],
      }),
      step({
        id: 2,
        position: 2,
        title: "Make password",
        secretCaptures: [{ name: "db_password", pattern: "pw: (\\S+)" }],
      }),
    ],
    ...overrides,
  };
}

function api(data = runbook()) {
  return {
    get: vi.fn(async (url: string) => ({
      data: url === "/runbooks" ? [summary] : data,
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
  fireEvent.click(await screen.findByText("Tokens"));
  await screen.findByText("Make password");
}

const card = (id: number) =>
  document.querySelector(`[data-step="${id}"]`) as HTMLElement;

describe("secret captures in the UI", () => {
  it("says which secrets a step captures and whether each is stored", async () => {
    await open(api());
    const stored = card(1).querySelector('[data-secret="api_token"]')!;
    expect(stored.getAttribute("data-secret-set")).toBe("true");
    expect(stored.textContent).toMatch(
      /^Captures secret api_token · stored in OpenBao until /,
    );
    expect(
      card(2).querySelector('[data-secret="db_password"]')!.textContent,
    ).toBe("Captures secret db_password · not stored");
    expect(
      card(1).querySelector("[data-run-secrets-stored]")!.textContent,
    ).toBe("Stored secret: api_token");
  });

  it("says so in the Run confirm", async () => {
    await open(api());
    fireEvent.click(within(card(2)).getByText(locales.step.run));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.querySelector("[data-confirm-secrets]")!.textContent).toBe(
      "Captures secret db_password: kept in OpenBao for 7 days, never shown.",
    );
  });

  it("blocks Run and Send without the service, and says why", async () => {
    const data = runbook({ secretsAvailable: false });
    (data.steps[1] as Record<string, unknown>).secretsProblem =
      "Install and connect the OpenBao Secrets plugin to use secrets";
    await open(api(data));
    expect(card(2).querySelector("[data-secrets-problem]")!.textContent).toBe(
      "Install and connect the OpenBao Secrets plugin to use secrets",
    );
    for (const label of [locales.step.run, locales.step.send]) {
      expect(within(card(2)).getByText(label).closest("button")!.disabled).toBe(
        true,
      );
    }
  });

  it("says the output is held while such a run runs", async () => {
    const data = runbook();
    (data.steps[1] as Record<string, unknown>).runs = [
      {
        ...run,
        id: 22,
        stepId: 2,
        status: "running",
        running: true,
        stdout: "",
        outputHeld: true,
        secrets: null,
        elapsedMs: 1000,
        silentMs: 0,
      },
    ];
    await open(api(data));
    expect(card(2).querySelector("[data-output-held]")!.textContent).toBe(
      "The output shows when the run ends: this step captures a secret.",
    );
  });
});
