import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { locales, useRenderedApp } from "./helpers";

const render = useRenderedApp();

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
  const rendered = await render(client, { isAdmin: true });
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

  it("copies the secret shown once and says Copied", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await show(api(false));
    await screen.findByText(locales.notify.none);
    fireEvent.click(button(locales.notify.make));
    const shown = await vi.waitFor(() => {
      const box = document.querySelector("[data-notify-shown]");
      expect(box).not.toBeNull();
      return box as HTMLElement;
    });
    const copy = within(shown).getByText(locales.notify.copy);
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(SECRET);
    await vi.waitFor(() => expect(copy.textContent).toBe(locales.step.copied));
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
