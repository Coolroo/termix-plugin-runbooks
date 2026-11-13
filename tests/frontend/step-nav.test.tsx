import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import {
  barItems,
  pressedKey,
  registerBarItem,
} from "../../src/frontend/nav/bar-items";
import {
  RAIL_MAX,
  RAIL_MIN,
  railSize,
  railWindow,
  stepsInView,
} from "../../src/frontend/nav/StepNav";
import type { RunbookStatus, StepStatus } from "../../src/frontend/api-types";
import {
  fakeApi,
  locales,
  makeRunbook,
  makeStep,
  openRunbook,
  useRenderedApp,
} from "./helpers";

useRenderedApp();

const removers: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const remove of removers.splice(0)) remove();
});

const step = (id: number, status: StepStatus) =>
  makeStep({
    id,
    runbookId: 9,
    title: `Step title ${id}`,
    commandHash: String(id).padStart(64, "0"),
    status,
  });

/**
 * A runbook of `total` steps, the first `done` of them done; with
 * `failedNext`, the step after them failed.
 */
function server(
  total: number,
  done: number,
  status: RunbookStatus = "open",
  failedNext = false,
) {
  const steps = Array.from({ length: total }, (_, index) =>
    step(
      index + 1,
      index < done
        ? "done"
        : index === done && failedNext
          ? "failed"
          : "pending",
    ),
  );
  return fakeApi({
    detail: makeRunbook(steps, {
      id: 9,
      title: "Long one",
      status,
      createdAt: "2026-11-12T10:00:00.000Z",
      updatedAt: "2026-11-12T10:05:00.000Z",
      revision: 3,
      progress: { done, failed: 0, total },
      nextStepId: done < total && status === "open" ? done + 1 : null,
    }),
    post: async () => ({ data: {} }),
  });
}

const rect = (top: number, bottom: number, width = 0) =>
  ({
    top,
    bottom,
    left: 0,
    right: width,
    width,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

/**
 * A layout for jsdom, which has none: each card 100 px tall from the top,
 * the scroller 500 px tall and `paneWidth` wide, scrolled to `scrollTop`.
 */
function layout(paneWidth: number, scrollTop = 0) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const id = this.getAttribute("data-step");
      if (id !== null && !this.hasAttribute("data-rail-step")) {
        const top = (Number(id) - 1) * 100 - scrollTop;
        return rect(top, top + 90);
      }
      if (this.hasAttribute("data-runbook-scroll")) {
        return rect(0, 500, paneWidth - 40);
      }
      if (this.querySelector?.(":scope > [data-runbook-scroll]")) {
        return rect(0, 500, paneWidth);
      }
      return rect(0, 0);
    },
  );
}

const open = (client: ReturnType<typeof server>) =>
  openRunbook(client, { title: "Long one", shows: "Step title 1" });

const bar = () => document.querySelector("[data-next-bar]") as HTMLElement;
const rail = () => document.querySelector("[data-step-rail]") as HTMLElement;
const railSteps = () =>
  [...document.querySelectorAll("[data-rail-step]")].map((dot) =>
    Number(dot.getAttribute("data-rail-step")),
  );
const card = (id: number) =>
  document.querySelector(`section[data-step="${id}"]`) as HTMLElement;

describe("the rail's window", () => {
  it("keeps a window of steps around the center, inside the runbook", () => {
    expect(railWindow(80, 40, 11)).toEqual({ start: 35, end: 46 });
    expect(railWindow(80, 2, 11)).toEqual({ start: 0, end: 11 });
    expect(railWindow(80, 79, 11)).toEqual({ start: 69, end: 80 });
    expect(railWindow(5, 4, 11)).toEqual({ start: 0, end: 5 });
  });

  it("fits as many steps as the rail's height allows", () => {
    expect(railSize(0)).toBe(RAIL_MAX);
    expect(railSize(2000)).toBe(RAIL_MAX);
    expect(railSize(100)).toBe(RAIL_MIN);
    expect(railSize(112 + 5 * 32)).toBe(5);
  });

  it("finds the steps whose cards are on screen", () => {
    const cards = [
      { top: -200, bottom: -110 },
      { top: -100, bottom: -10 },
      { top: 0, bottom: 90 },
      null,
      { top: 400, bottom: 490 },
      { top: 500, bottom: 590 },
    ];
    expect(stepsInView(cards, 0, 500)).toEqual({ first: 2, last: 4 });
    expect(stepsInView([{ top: 0, bottom: 0 }], 0, 500)).toBeNull();
    expect(stepsInView([], 0, 500)).toBeNull();
  });
});

describe("bar keys", () => {
  const key = (overrides: Partial<Parameters<typeof pressedKey>[0]>) =>
    pressedKey({
      key: "n",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      target: document.body,
      ...overrides,
    });

  it("are one letter or digit, never with a modifier or in a field", () => {
    expect(key({})).toBe("n");
    expect(key({ key: "N" })).toBe("n");
    expect(key({ key: "7" })).toBe("7");
    expect(key({ key: "Enter" })).toBeNull();
    expect(key({ ctrlKey: true })).toBeNull();
    expect(key({ shiftKey: true })).toBeNull();
    const field = document.createElement("textarea");
    document.body.append(field);
    expect(key({ target: field })).toBeNull();
    field.remove();
  });
});

describe("the bar registry", () => {
  it("starts with the built-in items, left to right", () => {
    expect(barItems().map((item) => item.id)).toEqual([
      "next-step",
      "next-kind",
      "go-to-step",
      "go-to-top",
    ]);
  });

  it("refuses bad ids and keys", () => {
    const button = {
      type: "button" as const,
      id: "copy",
      order: 1,
      label: () => "Copy",
      onClick: () => {},
    };
    expect(() => registerBarItem({ ...button, id: "Bad Id" })).toThrow();
    expect(() => registerBarItem({ ...button, key: "ctrl+c" })).toThrow();
  });

  it("draws a registered button in its place, with its key", async () => {
    layout(900);
    Element.prototype.scrollIntoView = vi.fn();
    const clicked = vi.fn();
    removers.push(
      registerBarItem({
        type: "button",
        id: "copy-command",
        order: 250,
        when: (ctx) => ctx.next !== null,
        label: (ctx) => `Copy step ${ctx.next!.label}`,
        icon: "Copy",
        key: "c",
        onClick: (ctx) => clicked(ctx.next!.step.id),
      }),
    );
    removers.push(
      registerBarItem({
        type: "custom",
        id: "left-count",
        order: 150,
        render: (ctx) => (
          <span data-left>
            {ctx.runbook.progress.total - ctx.runbook.progress.done} left
          </span>
        ),
      }),
    );
    await open(server(20, 3));

    const ids = [...bar().querySelectorAll("[data-bar-item]")].map((item) =>
      item.getAttribute("data-bar-item"),
    );
    expect(ids).toEqual(["copy-command", "go-to-step"]);
    const copy = bar().querySelector(
      "[data-bar-item='copy-command']",
    ) as HTMLElement;
    expect(copy.textContent).toBe("Copy step 4c");
    expect(bar().querySelector("[data-left]")!.textContent).toBe("17 left");

    fireEvent.click(copy);
    expect(clicked).toHaveBeenLastCalledWith(4);
    fireEvent.keyDown(card(1), { key: "c" });
    expect(clicked).toHaveBeenCalledTimes(2);
  });

  it("drops an item once it is removed, and hides it when `when` says no", async () => {
    const remove = registerBarItem({
      type: "button",
      id: "only-when-done",
      order: 250,
      when: (ctx) => ctx.next === null,
      label: () => "Report",
      onClick: () => {},
    });
    removers.push(remove);
    await open(server(5, 2));
    expect(bar().querySelector("[data-bar-item='only-when-done']")).toBeNull();
    remove();
    expect(barItems().some((item) => item.id === "only-when-done")).toBe(false);
  });
});

describe("the rail and the bar", () => {
  it("names the next step, and Go to step puts it in the middle", async () => {
    layout(900);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await open(server(80, 45));

    expect(bar().getAttribute("data-next-bar")).toBe("46");
    expect(bar().querySelector("[data-bar-caption]")!.textContent).toBe(
      "Next · step 46 of 80 · 45 done",
    );
    expect(bar().querySelector("[data-bar-title]")!.textContent).toBe(
      "Step title 46",
    );

    fireEvent.click(bar().querySelector("[data-bar-item='go-to-step']")!);
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(card(46));
    expect(scrolled.mock.calls[0][0]).toMatchObject({ block: "center" });
    expect(document.activeElement).toBe(card(46));
  });

  it("shows only the steps near the view, and pins the next step", async () => {
    layout(900);
    Element.prototype.scrollIntoView = vi.fn();
    await open(server(80, 45));

    // Steps 1 to 5 are on screen: the window is steps 1 to 11.
    await vi.waitFor(() =>
      expect(railSteps()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    );
    expect(
      rail().querySelector("[data-rail-view]")!.getAttribute("data-rail-view"),
    ).toBe("0-4");
    expect(rail().querySelector("[data-rail-count='earlier']")).toBeNull();
    expect(rail().querySelector("[data-rail-count='later']")!.textContent).toBe(
      "69",
    );
    // The next step is far below: pinned at the rail's edge.
    const pinned = rail().querySelector("[data-rail-pinned]") as HTMLElement;
    expect(pinned.getAttribute("data-rail-pinned")).toBe("46");
    expect(pinned.textContent).toBe("46");
    expect(pinned.getAttribute("aria-label")).toBe(
      "Next step 46: Step title 46",
    );
  });

  it("moves the window with the view, and says when the next step is on screen", async () => {
    // Scrolled so steps 44 to 48 are on screen.
    layout(900, 4300);
    Element.prototype.scrollIntoView = vi.fn();
    await open(server(80, 45));

    await vi.waitFor(() =>
      expect(
        rail()
          .querySelector("[data-rail-view]")
          ?.getAttribute("data-rail-view"),
      ).toBe("43-47"),
    );
    expect(railSteps()).toEqual([41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51]);
    expect(rail().querySelector("[data-rail-pinned]")).toBeNull();
    expect(
      rail().querySelector("[data-rail-count='earlier']")!.textContent,
    ).toBe("40");
    expect(rail().querySelector("[data-rail-count='later']")!.textContent).toBe(
      "29",
    );
    expect(
      rail().querySelector("[data-rail-step='46']")!.getAttribute("data-state"),
    ).toBe("current");
    expect(bar().hasAttribute("data-on-screen")).toBe(true);
    expect(bar().querySelector("[data-bar-caption]")!.textContent).toBe(
      "On screen · step 46 of 80 · 45 done",
    );
  });

  it("goes to a step from its dot, and shows its title on hover", async () => {
    layout(900);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await open(server(20, 3));

    const dot = await vi.waitFor(
      () => rail().querySelector("[data-rail-step='7']") as HTMLElement,
    );
    expect(dot.getAttribute("aria-label")).toBe("Go to step 7: Step title 7");
    fireEvent.mouseEnter(dot);
    expect(rail().querySelector("[data-rail-tip='7']")!.textContent).toBe(
      "7Step title 7",
    );
    fireEvent.click(dot);
    expect(scrolled.mock.contexts[0]).toBe(card(7));
  });

  it("goes to the next step on N, but not from a field", async () => {
    layout(900);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await open(server(20, 3));

    const view = document.querySelector("[data-runbook-view]") as HTMLElement;
    fireEvent.keyDown(card(1), { key: "n" });
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(card(4));

    const field = document.createElement("input");
    view.append(field);
    fireEvent.keyDown(field, { key: "n" });
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it("has no rail in a narrow pane, and a progress strip in the bar", async () => {
    layout(400);
    Element.prototype.scrollIntoView = vi.fn();
    await open(server(80, 45));

    await vi.waitFor(() => expect(rail()).toBeNull());
    expect(bar().querySelector("[data-bar-strip]")).not.toBeNull();
    expect(
      bar().querySelector("[data-bar-item='go-to-step']")!.textContent,
    ).toBe(locales.nav.go);
  });

  it("says when every step is done, and goes to the top", async () => {
    await open(server(3, 3));
    expect(bar().getAttribute("data-next-bar")).toBe("none");
    expect(bar().querySelector("[data-bar-caption]")!.textContent).toBe(
      "All 3 steps done",
    );
    const scroller = document.querySelector(
      "[data-runbook-scroll]",
    ) as HTMLElement;
    scroller.scrollTop = 300;
    fireEvent.click(bar().querySelector("[data-bar-item='go-to-top']")!);
    expect(scroller.scrollTop).toBe(0);
  });

  it("says when the next step failed, in red on the rail", async () => {
    layout(900);
    Element.prototype.scrollIntoView = vi.fn();
    await open(server(10, 3, "open", true));
    expect(bar().querySelector("[data-bar-caption]")!.textContent).toBe(
      "Failed · step 4 of 10 · 3 done",
    );
    const dot = await vi.waitFor(
      () => rail().querySelector("[data-rail-step='4']") as HTMLElement,
    );
    expect(dot.getAttribute("data-state")).toBe("failed");
  });

  it("says a closed runbook is closed", async () => {
    await open(server(5, 2, "abandoned"));
    expect(bar().getAttribute("data-next-bar")).toBe("none");
    expect(bar().querySelector("[data-bar-caption]")!.textContent).toBe(
      "Runbook Abandoned",
    );
  });
});

describe("one kind for the card, the rail and the bar", () => {
  it("names the last step's kind the same way in all three", async () => {
    const client = fakeApi({
      detail: makeRunbook(
        [
          makeStep({ id: 1, title: "Step title 1", status: "done" }),
          makeStep({
            id: 2,
            title: "Finish up",
            hostId: null,
            hostName: null,
            command: null,
            resolvedCommand: null,
            commandHash: null,
          }),
        ],
        { title: "Long one" },
      ),
    });
    await open(client);
    const cardKind = card(2)
      .querySelector("header [data-kind]")!
      .getAttribute("data-kind");
    expect(cardKind).toBe("finish");
    expect(card(2).getAttribute("data-kind")).toBe("finish");
    const barChip = bar().querySelector("[data-kind]") as HTMLElement;
    expect(barChip.getAttribute("data-kind")).toBe("finish");
    expect(barChip.textContent).toBe(
      card(2).querySelector("header [data-kind]")!.textContent,
    );
    expect(
      rail().querySelector("[data-rail-step='2']")!.getAttribute("data-state"),
    ).toBe("current");
  });
});
