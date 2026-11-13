import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  fakeApi,
  locales,
  makeRun,
  makeRunbook,
  makeSummary,
  makeStep,
  manifest,
  openRunbook,
  useRenderedApp,
} from "./helpers";

const render = useRenderedApp();

const runbook = makeRunbook(
  [
    makeStep({
      id: 1,
      title: "Check status",
      command: "systemctl status {{svc}}",
      resolvedCommand: "systemctl status nginx",
      status: "done",
      runs: [
        makeRun({
          id: 11,
          command: "systemctl status nginx",
          finishedAt: "2026-11-07T10:01:01.000Z",
          stdout: "active (running)",
        }),
      ],
    }),
    makeStep({
      id: 2,
      title: "Restart",
      command: "systemctl restart {{svc}}",
      resolvedCommand: "systemctl restart nginx",
      commandHash: "b".repeat(64),
      expect: "No output.",
    }),
    makeStep({
      id: 3,
      title: "Deploy",
      command: "deploy {{version}}",
      resolvedCommand: "deploy {{version}}",
      commandHash: null,
      missing: ["version"],
    }),
  ],
  {
    title: "Restart web",
    summary: "Restart **nginx** <script>alert(1)</script>",
    values: { svc: "nginx" },
    effectiveValues: [{ name: "svc", value: "nginx", source: "author" }],
    nextStepId: 2,
  },
);

const api = () => fakeApi({ detail: runbook });

describe(`${manifest.id} frontend`, () => {
  it("registers the rail item and tab", async () => {
    const rendered = await render(undefined);
    expect(rendered.registered.tabs()).toEqual(["runbooks"]);
    expect(rendered.registered.railItems()).toEqual([
      expect.objectContaining({ id: "runbooks", permission: "runbooks.use" }),
    ]);
  });

  it("lists runbooks and opens one with resolved commands", async () => {
    const client = api();
    await openRunbook(client, { title: "Restart web" });

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
    await openRunbook(client, { title: "Restart web" });
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
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
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
                    {
                      id: 3,
                      name: "desk-1",
                      address: "10.0.0.3",
                      folder: null,
                      ssh: false,
                    },
                  ],
                  createdAt: "2026-11-07T10:00:00.000Z",
                  lastUsedAt: null,
                  revokedAt: null,
                },
              ]
            : [makeSummary({ title: "Restart web" })],
      })),
      post: vi.fn(async () => ({
        data: { id: 6, name: "lead", prefix: "rbk_wxyz", token: "rbk_secret" },
      })),
    };
    const rendered = await render(client, {
      permissions: ["runbooks.use", "runbooks.manage-tokens"],
      hosts: [
        { id: 1, name: "web-1", ip: "10.0.0.1", folder: "web" },
        { id: 2, name: "db-1", ip: "10.0.0.2", folder: null },
        {
          id: 3,
          name: "desk-1",
          ip: "10.0.0.3",
          connectionType: "rdp",
          enableSsh: false,
        },
        { id: 4, name: "vnc-1", ip: "10.0.0.4", connectionType: "vnc" },
      ],
    });
    rendered.renderTab("runbooks", { isVisible: true });
    fireEvent.click(await screen.findByText(locales.tokens.title));

    // The existing token shows its hosts, a remote desktop one marked.
    const row = (await screen.findByText("old")).closest("tr") as HTMLElement;
    expect(
      within(row).getByText("db-1, desk-1 (not SSH, not offered to agents)"),
    ).toBeTruthy();
    // Only SSH hosts can be ticked.
    expect(screen.queryByText("desk-1")).toBeNull();
    expect(screen.queryByText("vnc-1")).toBeNull();

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
    // Copy says so, as every other Copy button does.
    const box = screen.getByText("rbk_secret").parentElement as HTMLElement;
    const copy = within(box).getByText(locales.step.copy);
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith("rbk_secret");
    await vi.waitFor(() => expect(copy.textContent).toBe(locales.step.copied));

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
