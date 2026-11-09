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

const SECRET = "s".repeat(43);

function api(secretSet: boolean) {
  let set = secretSet;
  return {
    get: vi.fn(async () => ({
      data: {
        enabled: true,
        url: "https://agents.example.test/hook",
        problem: set ? null : "no signing secret: make one in the settings",
        secret: set
          ? {
              set: true,
              madeAt: "2026-11-09T10:00:00.000Z",
              madeBy: "alice",
            }
          : { set: false, madeAt: null, madeBy: null },
      },
    })),
    post: vi.fn(async (url: string) => {
      if (url === "/admin/notify/secret") {
        set = true;
        return {
          data: {
            secret: SECRET,
            madeAt: "2026-11-09T11:00:00.000Z",
            madeBy: "alice",
          },
        };
      }
      return { data: { ok: true, status: 204, error: null } };
    }),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

async function show(client: ReturnType<typeof api>) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api: client as never,
    isAdmin: true,
  });
  expect(rendered.registered.settingsComponents()).toContain("notify-secret");
  return rendered.renderSettingsComponent("notify-secret", { running: true });
}

const button = (label: string) =>
  screen
    .getAllByRole("button")
    .find((element) => element.textContent === label)!;

describe("the signing secret section", () => {
  it("makes a secret and shows it once", async () => {
    const client = api(false);
    await show(client);
    await screen.findByText(locales.notify.none);
    expect(
      document.querySelector("[data-notify-problem]")!.textContent,
    ).toContain("no signing secret");
    fireEvent.click(button(locales.notify.make));
    const shown = await vi.waitFor(() => {
      const box = document.querySelector("[data-notify-shown]");
      expect(box).not.toBeNull();
      return box as HTMLElement;
    });
    expect(shown.textContent).toContain(SECRET);
    expect(shown.textContent).toContain(locales.notify.once);
    expect(client.post).toHaveBeenCalledWith("/admin/notify/secret");
    fireEvent.click(within(shown).getByText(locales.notify.hide));
    expect(document.querySelector("[data-notify-shown]")).toBeNull();
    // Only the time and who made it stay.
    expect(document.body.textContent).not.toContain(SECRET);
    expect(
      document.querySelector('[data-notify-secret="true"]'),
    ).not.toBeNull();
  });

  it("asks before it replaces a secret", async () => {
    const client = api(true);
    await show(client);
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-notify-secret="true"]'),
      ).not.toBeNull(),
    );
    fireEvent.click(button(locales.notify.make));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(locales.notify.replaceHint);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("sends a test and shows the HTTP status", async () => {
    const client = api(true);
    await show(client);
    fireEvent.click(button(locales.notify.test));
    const result = await vi.waitFor(() => {
      const line = document.querySelector("[data-notify-test]");
      expect(line).not.toBeNull();
      return line as HTMLElement;
    });
    expect(result.dataset.notifyTest).toBe("ok");
    expect(result.textContent).toBe(
      "Test sent: the receiver answered HTTP 204.",
    );
    expect(client.post).toHaveBeenCalledWith("/admin/notify/test");
  });
});
