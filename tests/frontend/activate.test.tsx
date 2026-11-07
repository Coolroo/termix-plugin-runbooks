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
  title: "Restart web",
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
    command: null,
    resolvedCommand: null,
    commandHash: null,
    missing: [],
    expect: "",
    captures: [],
    hideOutputFromAgents: false,
    status: "pending",
    skipReason: null,
    ownerNote: "",
    timeoutMs: null,
    revision: 1,
    runs: [],
    ...overrides,
  };
}

const runbook = {
  ...summary,
  summary: "Restart **nginx** <script>alert(1)</script>",
  values: { svc: "nginx" },
  effectiveValues: [{ name: "svc", value: "nginx", source: "author" }],
  nextStepId: 2,
  steps: [
    step({
      id: 1,
      position: 1,
      title: "Check status",
      command: "systemctl status {{svc}}",
      resolvedCommand: "systemctl status nginx",
      commandHash: "a".repeat(64),
      status: "done",
      runs: [
        {
          id: 11,
          stepId: 1,
          runbookId: 7,
          mode: "exec",
          status: "done",
          hostId: 1,
          command: "systemctl status nginx",
          commandHash: "a".repeat(64),
          userId: "alice",
          startedAt: "2026-11-07T10:01:00.000Z",
          finishedAt: "2026-11-07T10:01:01.000Z",
          exitCode: 0,
          stdout: "active (running)",
          stderr: "",
          truncated: false,
          timedOut: false,
          pastedOutput: null,
          error: null,
          captured: {},
        },
      ],
    }),
    step({
      id: 2,
      position: 2,
      title: "Restart",
      command: "systemctl restart {{svc}}",
      resolvedCommand: "systemctl restart nginx",
      commandHash: "b".repeat(64),
      expect: "No output.",
    }),
    step({
      id: 3,
      position: 3,
      title: "Deploy",
      command: "deploy {{version}}",
      resolvedCommand: "deploy {{version}}",
      missing: ["version"],
    }),
  ],
};

function api() {
  return {
    get: vi.fn(async (url: string) => ({
      data: url === "/runbooks" ? [summary] : runbook,
    })),
    post: vi.fn(async () => ({ data: runbook })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

describe(`${manifest.id} frontend`, () => {
  it("registers the rail item and tab", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["runbooks"]);
    expect(rendered.registered.railItems()).toEqual([
      expect.objectContaining({ id: "runbooks", permission: "runbooks.use" }),
    ]);
  });

  it("lists runbooks and opens one with resolved commands", async () => {
    const client = api();
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: client as never,
    });
    rendered.renderTab("runbooks", { isVisible: true });
    fireEvent.click(await screen.findByText("Restart web"));

    expect(await screen.findByText("systemctl restart nginx")).toBeTruthy();
    expect(client.get).toHaveBeenCalledWith("/runbooks/7");

    // Markdown renders; raw HTML does not.
    expect(screen.getByText("nginx", { selector: "strong" })).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();

    // The next pending step is marked.
    const next = document.querySelector('[data-step="2"]') as HTMLElement;
    expect(next.getAttribute("aria-current")).toBe("step");
    expect(within(next).getByText(locales.step.next)).toBeTruthy();

    // A step with a missing value names it and cannot run.
    const blocked = document.querySelector('[data-step="3"]') as HTMLElement;
    expect(within(blocked).getByText(/Values missing: version/)).toBeTruthy();
    const runButton = within(blocked).getByText(locales.step.run);
    expect((runButton.closest("button") as HTMLButtonElement).disabled).toBe(
      true,
    );

    // The latest run shows its output.
    const done = document.querySelector('[data-step="1"]') as HTMLElement;
    expect(within(done).getByText("active (running)")).toBeTruthy();
  });

  it("asks before running and sends what the person saw", async () => {
    const client = api();
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: client as never,
    });
    rendered.renderTab("runbooks", { isVisible: true });
    fireEvent.click(await screen.findByText("Restart web"));
    const card = (
      await screen.findByText("Restart", {
        selector: "h3",
      })
    ).closest("section") as HTMLElement;
    fireEvent.click(within(card).getByText(locales.step.run));

    // The confirm shows the host and the exact command.
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Run step 2?")).toBeTruthy();
    expect(within(dialog).getByText("web-1")).toBeTruthy();
    expect(within(dialog).getByText("systemctl restart nginx")).toBeTruthy();
    expect(client.post).not.toHaveBeenCalled();

    const confirmButton = within(dialog)
      .getAllByRole("button")
      .find((button) => button.textContent?.startsWith(locales.run.confirm))!;
    fireEvent.click(confirmButton);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/2/run", {
        revision: 1,
        commandHash: "b".repeat(64),
      }),
    );
  });

  it("makes a token for the hosts the person ticks", async () => {
    const client = {
      ...api(),
      get: vi.fn(async (url: string) => ({
        data:
          url === "/tokens"
            ? [
                {
                  id: 5,
                  name: "old",
                  prefix: "rbk_abcd",
                  createdBy: "alice",
                  hosts: [
                    { id: 2, name: "db-1", address: "10.0.0.2", folder: null },
                  ],
                  createdAt: "2026-11-07T10:00:00.000Z",
                  lastUsedAt: null,
                  revokedAt: null,
                },
              ]
            : [summary],
      })),
      post: vi.fn(async () => ({
        data: { id: 6, name: "lead", prefix: "rbk_wxyz", token: "rbk_secret" },
      })),
    };
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["runbooks.use", "runbooks.manage-tokens"],
      hosts: [
        { id: 1, name: "web-1", ip: "10.0.0.1", folder: "web" },
        { id: 2, name: "db-1", ip: "10.0.0.2", folder: null },
      ],
      api: client as never,
    });
    rendered.renderTab("runbooks", { isVisible: true });
    fireEvent.click(await screen.findByText(locales.tokens.title));

    // The existing token shows its hosts.
    const row = (await screen.findByText("old")).closest("tr") as HTMLElement;
    expect(within(row).getByText("db-1")).toBeTruthy();

    fireEvent.change(
      screen.getByPlaceholderText(locales.tokens.namePlaceholder),
      {
        target: { value: "lead" },
      },
    );
    const make = screen.getByText(locales.tokens.create).closest("button")!;
    // No host ticked yet.
    expect(make.disabled).toBe(true);
    const form = make.closest("form") as HTMLElement;
    fireEvent.click(within(form).getByText("web-1"));
    expect(make.disabled).toBe(false);
    fireEvent.click(make);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/tokens", {
        name: "lead",
        hostIds: [1],
      }),
    );
    expect(await screen.findByText("rbk_secret")).toBeTruthy();

    // Change the old token's hosts.
    fireEvent.click(within(row).getByText(locales.tokens.editHosts));
    fireEvent.click(within(row).getByText("web-1"));
    fireEvent.click(within(row).getByText(locales.tokens.saveHosts));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/tokens/5/hosts", {
        hostIds: [2, 1],
      }),
    );
  });
});
