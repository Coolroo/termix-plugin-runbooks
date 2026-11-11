import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";
import { cardState, kindStyle, resolveColor } from "../../src/frontend/kinds";
import {
  BUILT_IN_KINDS,
  cleanColors,
  colorsProblem,
  COLORS_SETTING,
  effectiveColors,
  FALLBACK_KIND,
  kindOf,
  nextKind,
  registerStepKind,
  stepKinds,
  validateColors,
  type StepKind,
} from "../../src/shared/step-kinds";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;
const removers: Array<() => void> = [];

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  for (const remove of removers.splice(0)) remove();
});

const base = {
  title: "A step",
  owner: "person" as const,
  command: null,
  hostId: null,
  where: null,
};
const mid = { last: false };
const last = { last: true };

describe("kinds of step", () => {
  it("come from the fields a step already has", () => {
    const kind = (step: object, runbook = mid) =>
      kindOf({ ...base, ...step }, runbook).id;
    expect(kind({ command: "uptime", hostId: 1 })).toBe("run");
    expect(kind({ owner: "agent", command: "make test" })).toBe("lead");
    // The lead's step wins, with or without a host.
    expect(kind({ owner: "agent", hostId: 1 }, last)).toBe("lead");
    expect(kind({ command: "Get-Date", where: "Windows PC" })).toBe("outside");
    expect(kind({ title: "Open the dashboard" })).toBe("app");
    expect(kind({ title: "Finish the runbook" }, last)).toBe("finish");
    expect(kind({ title: "finish: mark it done" }, last)).toBe("finish");
    // Finish is only the last step, with no command, named Finish.
    expect(kind({ title: "Finish the runbook" })).toBe("app");
    expect(kind({ title: "Finishing touches" }, last)).toBe("app");
    expect(kind({ title: "Finish", command: "x", hostId: 1 }, last)).toBe(
      "run",
    );
  });

  it("take the highest priority that matches, else the fallback", () => {
    expect(stepKinds().map((kind) => kind.id)).toEqual([
      "lead",
      "make-secret",
      "ask-secret",
      "run",
      "outside",
      "finish",
      "app",
    ]);
    // A command with neither host nor where matches no kind but the fallback.
    expect(kindOf({ ...base, command: "x" }, mid).id).toBe(FALLBACK_KIND);
    const high: StepKind = {
      id: "test-high",
      nameKey: "kind.name.run",
      icon: "Star",
      label: () => "High",
      defaultColor: { light: "#000000", dark: "#ffffff" },
      matches: (step) => step.title === "Special",
      priority: 99,
    };
    removers.push(registerStepKind(high));
    expect(kindOf({ ...base, title: "Special", owner: "agent" }, mid).id).toBe(
      "test-high",
    );
    expect(kindOf({ ...base, title: "Other", owner: "agent" }, mid).id).toBe(
      "lead",
    );
    expect(() => registerStepKind({ ...high, id: "Bad Id" })).toThrow();
  });

  it("give the next step's kind for the list", () => {
    const steps = [
      { ...base, status: "done", command: "a", hostId: 1 },
      { ...base, status: "pending", owner: "agent" as const },
      { ...base, status: "pending", title: "Finish" },
    ];
    expect(nextKind(steps)).toBe("lead");
    expect(nextKind(steps.slice(2))).toBe("finish");
    expect(nextKind([{ ...steps[0] }])).toBeNull();
  });

  it("style the current step, and failed over the kind, from one helper", () => {
    expect(cardState({ status: "pending" }, true)).toBe("current");
    expect(cardState({ status: "pending" }, false)).toBe("pending");
    expect(cardState({ status: "done" }, false)).toBe("done");
    expect(cardState({ status: "failed" }, false)).toBe("failed");
    expect(cardState({ status: "skipped" }, false)).toBe("grey");
    expect(cardState({ status: "replaced" }, false)).toBe("grey");
    const current = kindStyle.card("current", "#123456");
    expect(current).toMatchObject({ borderWidth: 2, borderColor: "#123456" });
    expect(String(current.boxShadow)).toContain("#123456");
    expect(kindStyle.card("pending", "#123456")).toEqual({
      borderLeftWidth: 3,
      borderLeftColor: "#123456",
    });
    expect(String(kindStyle.card("done", "#123456").borderLeftColor)).toContain(
      "40%",
    );
    expect(kindStyle.card("failed", "#123456").borderLeftColor).toBe(
      "var(--destructive)",
    );
    expect(String(kindStyle.card("grey", "#123456").borderLeftColor)).toContain(
      "--muted-foreground",
    );
    expect(kindStyle.dot("#123456")).toEqual({ background: "#123456" });
  });
});

/** WCAG contrast of two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe("default colors", () => {
  // Termix's light card (oklch 100%) and dark card and page (oklch 21% and
  // 15.5%), in sRGB.
  const LIGHT = ["#ffffff"];
  const DARK = ["#181917", "#0c0d0b"];
  const HEX = /^#[0-9a-f]{6}$/i;

  for (const kind of BUILT_IN_KINDS) {
    it(`${kind.id}: a Termix token, or at least 4.5:1 on light and dark`, () => {
      for (const [mode, backgrounds] of [
        ["light", LIGHT],
        ["dark", DARK],
      ] as const) {
        const color = kind.defaultColor[mode];
        if (!HEX.test(color)) {
          expect(color).toMatch(/var\(--|oklch\(/);
          continue;
        }
        for (const bg of backgrounds) {
          expect(contrast(color, bg)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});

describe("step colors from the settings", () => {
  it("take a set color over the default, and fall back when empty", () => {
    const colors = { run: "#ff8800" };
    expect(resolveColor("run", colors, "dark")).toBe("#ff8800");
    expect(resolveColor("run", colors, "light")).toBe("#ff8800");
    const lead = BUILT_IN_KINDS.find((kind) => kind.id === "lead")!;
    expect(resolveColor("lead", colors, "light")).toBe(lead.defaultColor.light);
    expect(resolveColor("lead", colors, "dark")).toBe(lead.defaultColor.dark);
  });

  it("keep only #rgb and #rrggbb of known kinds; a person's win", () => {
    expect(
      cleanColors({
        run: "#22C55E",
        lead: "blue",
        app: "#abc",
        finish: "#fff;background:url(x)",
        "no-such-kind": "#000",
      }),
    ).toEqual({ run: "#22c55e", app: "#abc" });
    expect(
      effectiveColors(
        { run: "#111", lead: "#222" },
        { lead: "#333", app: "x" },
      ),
    ).toEqual({ run: "#111", lead: "#333" });
    expect(colorsProblem(undefined)).toBeNull();
    expect(colorsProblem({ run: "", lead: "#ABC" })).toBeNull();
    for (const bad of [
      "red",
      ["#fff"],
      { run: "red" },
      { run: "#12345" },
      { run: "#22c55e;" },
      { run: "var(--x)" },
      { "Bad Id": "#fff" },
      { run: 12 },
    ]) {
      expect(colorsProblem(bad)).not.toBeNull();
    }
    expect(validateColors({ [COLORS_SETTING]: { lead: "nope" } })).toEqual({
      stepColors: expect.stringContaining("#rrggbb"),
    });
    expect(validateColors({ notifyUrl: "x" })).toEqual({});
  });

  it("are one setting per scope in the manifest, drawn by the editor", () => {
    const settings = manifestJson.contributes.settings as Record<
      string,
      Array<{ key: string; type: string; component?: string }>
    >;
    for (const [scope, component] of [
      ["admin", "step-colors"],
      ["user", "step-colors-user"],
    ]) {
      expect(settings[scope]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: COLORS_SETTING, type: "json" }),
          expect.objectContaining({ type: "custom", component }),
        ]),
      );
    }
  });
});

const summary = {
  id: 7,
  title: "Kinds",
  status: "open",
  createdBy: "lead",
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:05:00.000Z",
  revision: 4,
  progress: { done: 1, failed: 1, total: 8 },
  nextKind: "outside",
};

function step(overrides: Record<string, unknown>) {
  return {
    runbookId: 7,
    body: "",
    hostId: null,
    hostName: null,
    command: null,
    resolvedCommand: null,
    commandHash: null,
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
    owner: "person",
    where: null,
    ...overrides,
  };
}

const data = {
  ...summary,
  summary: "",
  values: {},
  effectiveValues: [],
  nextStepId: 4,
  owner: { label: "lead" },
  agentLabel: "lead",
  steps: [
    step({
      id: 1,
      position: 1,
      title: "Check the disk",
      hostId: 1,
      hostName: "web-1",
      command: "df -h",
      resolvedCommand: "df -h",
      commandHash: "h1",
      status: "done",
    }),
    step({
      id: 2,
      position: 2,
      title: "Make a token",
      hostId: 1,
      hostName: "web-1",
      command: "make-token",
      resolvedCommand: "make-token",
      commandHash: "h2",
      status: "failed",
      secretCaptures: [{ name: "api_token", pattern: "(\\S+)" }],
    }),
    step({
      id: 3,
      position: 3,
      title: "Read the graph",
      owner: "agent",
      status: "skipped",
      skipReason: "not needed",
    }),
    step({
      id: 4,
      position: 4,
      title: "Check Windows",
      command: "Get-Date",
      resolvedCommand: "Get-Date",
      where: "Windows PC",
      waitAfterPreviousSeconds: 60,
    }),
    step({
      id: 5,
      position: 5,
      title: "Restart",
      hostId: 2,
      hostName: "web-2",
      command: "systemctl restart app",
      resolvedCommand: "systemctl restart app",
      commandHash: "h5",
      stdin: {
        source: { from: "secret", name: "api_token" },
        bytes: null,
        preview: null,
        problem: null,
      },
    }),
    step({ id: 6, position: 6, title: "Open the dashboard" }),
    step({ id: 7, position: 7, title: "Read the logs", owner: "agent" }),
    step({ id: 8, position: 8, title: "Finish the runbook" }),
  ],
};

function api(colors: unknown = {}, steps?: unknown[]) {
  const shown = steps ? { ...data, steps, nextStepId: 1 } : data;
  return {
    get: vi.fn(async (url: string) => ({
      data:
        url === "/runbooks" ? [summary] : url === "/colors" ? colors : shown,
    })),
    post: vi.fn(async () => ({ data })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

const card = (id: number) =>
  document.querySelector(`[data-step="${id}"]`) as HTMLElement;
const chip = (id: number) =>
  card(id).querySelector("[data-kind]:not([data-step])") as HTMLElement;

async function open(client = api()) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api: client as never,
  });
  rendered.renderTab("runbooks", { isVisible: true });
  const row = await screen.findByText("Kinds");
  return { client, row };
}

describe("step cards", () => {
  it("show each kind's icon and label, and the Secret and Wait marks", async () => {
    const { row } = await open();
    fireEvent.click(row);
    await screen.findByText("Check Windows");
    const expected: Array<[number, string, string]> = [
      [1, "run", "Run on web-1"],
      [2, "run", "Run on web-1"],
      [3, "lead", "lead's step"],
      [4, "outside", "Run outside Termix"],
      [5, "run", "Run on web-2"],
      [6, "app", "Do it yourself"],
      [7, "lead", "lead's step"],
      [8, "finish", "Finish"],
    ];
    for (const [id, kind, label] of expected) {
      expect(card(id).getAttribute("data-kind")).toBe(kind);
      expect(chip(id).getAttribute("data-kind")).toBe(kind);
      expect(chip(id).textContent).toBe(label);
      // Color is never the only sign: every kind has an icon.
      expect(chip(id).querySelector("svg")).not.toBeNull();
    }
    expect(chip(7).hasAttribute("data-agent-step")).toBe(true);
    const marks = (id: number) =>
      [...card(id).querySelectorAll("[data-mark]")].map((mark) =>
        mark.getAttribute("data-mark"),
      );
    expect(marks(2)).toEqual(["secret"]);
    expect(marks(5)).toEqual(["secret"]);
    expect(marks(4)).toEqual(["wait"]);
    expect(marks(6)).toEqual([]);
    expect(card(2).querySelector('[data-mark="secret"]')!.textContent).toBe(
      locales.kind.mark.secret,
    );
  });

  it("mark the current step, and show failed, done and grey states", async () => {
    const { row } = await open();
    fireEvent.click(row);
    await screen.findByText("Check Windows");
    const state = (id: number) => card(id).getAttribute("data-state");
    expect(state(4)).toBe("current");
    expect(card(4).getAttribute("aria-current")).toBe("step");
    expect(card(4).style.borderWidth).toBe("2px");
    expect(state(1)).toBe("done");
    expect(state(2)).toBe("failed");
    // Failed is red whatever the kind; the kind's label stays.
    expect(card(2).style.borderLeftColor).toBe("var(--destructive)");
    expect(chip(2).getAttribute("data-kind")).toBe("run");
    expect(card(2).textContent).toContain(locales.step.status.failed);
    expect(state(3)).toBe("grey");
    for (const id of [5, 6, 7, 8]) {
      expect(state(id)).toBe("pending");
      expect(card(id).style.borderLeftWidth).toBe("3px");
    }
  });

  it("use a color set in the settings, and drop anything that is not a color", async () => {
    const { row } = await open(
      api({ run: "#ff8800", app: "red;background:url(x)", lead: "#00f" }),
    );
    fireEvent.click(row);
    await screen.findByText("Check Windows");
    await vi.waitFor(() =>
      expect(card(5).style.borderLeftColor).toBe("rgb(255, 136, 0)"),
    );
    expect(card(7).style.borderLeftColor).toBe("rgb(0, 0, 255)");
    expect(card(6).getAttribute("style") ?? "").not.toContain("url(");
  });

  it("show the next step's kind beside the progress in the list", async () => {
    await open(api({ outside: "#aa00aa" }));
    const dot = document.querySelector("[data-next-kind]") as HTMLElement;
    expect(dot.getAttribute("data-next-kind")).toBe("outside");
    expect(dot.textContent).toBe("Outside Termix");
    expect(dot.getAttribute("aria-label")).toBe("Next: Outside Termix");
    expect(dot.querySelector("svg")).not.toBeNull();
    await vi.waitFor(() =>
      expect(
        (dot.querySelector("span[aria-hidden]") as HTMLElement).style
          .background,
      ).toBe("rgb(170, 0, 170)"),
    );
  });
});

describe("a kind added to the registry", () => {
  const extra: StepKind = {
    id: "type-secret",
    nameKey: "kind.name.app",
    icon: "KeyRound",
    label: () => "Type a secret",
    defaultColor: { light: "#0f766e", dark: "#2dd4bf" },
    matches: (step) => /secret/i.test(step.title),
    priority: 45,
  };

  it("gets its own field in the settings", async () => {
    removers.push(registerStepKind(extra));
    rendered = await renderWithApp(plugin, { manifest, locales });
    const element = rendered.renderSettingsComponent("step-colors", {
      values: {},
      setValue: vi.fn(),
      running: true,
    });
    const field = element.querySelector('[data-color-row="type-secret"]')!;
    expect(field).not.toBeNull();
    expect(field.querySelector("svg")).not.toBeNull();
  });

  it("draws its color, icon and label on a step it matches, and its list dot", async () => {
    removers.push(registerStepKind(extra));
    const { row } = await open(
      api({ "type-secret": "#123456" }, [
        step({
          id: 1,
          position: 1,
          title: "Type the secret",
          status: "pending",
        }),
      ]),
    );
    fireEvent.click(row);
    await screen.findByText("Type the secret");
    expect(card(1).getAttribute("data-kind")).toBe("type-secret");
    expect(chip(1).textContent).toBe("Type a secret");
    expect(chip(1).querySelector("svg")).not.toBeNull();
    await vi.waitFor(() =>
      expect(card(1).style.borderColor).toBe("rgb(18, 52, 86)"),
    );
    expect(
      nextKind([{ ...base, title: "Type the secret", status: "pending" }]),
    ).toBe("type-secret");
  });
});

describe("the step colors setting", () => {
  it("edits one color per registered kind, says what is wrong and resets", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.settingsComponents()).toEqual(
      expect.arrayContaining(["step-colors", "step-colors-user"]),
    );
    const setValue = vi.fn();
    const element = rendered.renderSettingsComponent("step-colors", {
      values: { [COLORS_SETTING]: { run: "#22c55e", lead: "blue" } },
      setValue,
      running: true,
    });
    expect(
      [...element.querySelectorAll("[data-color-row]")].map((row) =>
        row.getAttribute("data-color-row"),
      ),
    ).toEqual(stepKinds().map((kind) => kind.id));
    const run = element.querySelector('[data-color-row="run"]')!;
    const lead = element.querySelector('[data-color-row="lead"]')!;
    expect(run.querySelector("[data-color-problem]")).toBeNull();
    expect(lead.querySelector("[data-color-problem]")!.textContent).toContain(
      "#rrggbb",
    );
    fireEvent.change(run.querySelector('input[type="color"]')!, {
      target: { value: "#112233" },
    });
    expect(setValue).toHaveBeenLastCalledWith(COLORS_SETTING, {
      run: "#112233",
      lead: "blue",
    });
    fireEvent.click(
      [...run.querySelectorAll("button")].find(
        (button) => button.textContent === locales.settings.colors.reset,
      )!,
    );
    expect(setValue).toHaveBeenLastCalledWith(COLORS_SETTING, {
      lead: "blue",
    });
    const user = rendered.renderSettingsComponent("step-colors-user", {
      values: {},
      setValue,
      running: true,
    });
    expect(user.textContent).toContain(locales.settings.colors.userTitle);
  });
});
