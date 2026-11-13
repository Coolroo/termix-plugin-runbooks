import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import {
  card,
  clickStep,
  fakeApi,
  locales,
  makeRunbook,
  makeStep,
  openRunbook,
  useRenderedApp,
  type FakeApi,
} from "./helpers";
import type { Runbook, Step } from "../../src/frontend/api-types";

useRenderedApp();

afterEach(() => {
  vi.restoreAllMocks();
});

const restart = { id: 1, position: 1, label: "1", title: "Restart" };

/** A 409 answer as the server sends it. */
const conflict = (data: Record<string, unknown>) => ({
  response: { status: 409, data: { error: "refused", ...data } },
});

/** Step 1 pending, step 2 a command, step 3 done, step 4 makes a secret. */
function runbook(overrides: Partial<Runbook> = {}): Runbook {
  return makeRunbook(
    [
      clickStep({ id: 1, title: "Restart", ownerNote: "" }),
      makeStep({ id: 2, title: "Check", commandHash: "b".repeat(64) }),
      clickStep({ id: 3, title: "Report", status: "done" }),
      clickStep({
        id: 4,
        title: "Password",
        revision: 2,
        generate: {
          name: "db_pw",
          format: "alnum",
          length: 32,
          store: "runbook",
        },
        secretStep: {
          kind: "generate",
          name: "db_pw",
          mode: "ready",
          reason: null,
          byHand: { engine: "kv", path: "runbooks/7", field: "db_pw" },
          set: false,
          expiresAt: null,
        },
      }),
    ],
    { title: "Upgrade", nextStepId: 1, ...overrides },
  );
}

/** Answers the first POST with `first` (thrown when an error), then `rest`. */
function answers(first: unknown, rest: () => unknown = () => runbook()) {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      if ((first as { response?: unknown })?.response) throw first;
      return { data: first };
    }
    return { data: rest() };
  };
}

async function open(post?: (url: string, body?: unknown) => Promise<unknown>) {
  const client = fakeApi({ detail: runbook, post });
  await openRunbook(client, { title: "Upgrade", shows: "Restart" });
  return client;
}

/** Clicks the button in the open confirm whose text starts with `label`. */
async function pick(label: string) {
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(
    within(dialog)
      .getAllByRole("button")
      .find((button) => button.textContent?.startsWith(label))!,
  );
}

const runStep2 = async () => {
  fireEvent.click(within(card(2)).getByText(locales.step.run));
  await pick(locales.run.confirm);
};

const gets = (client: FakeApi) =>
  client.get.mock.calls.filter(([url]) => url === "/runbooks/7").length;

describe("a Run the server refuses", () => {
  it("asks about the order and runs out of order on a yes", async () => {
    const client = await open(
      answers(conflict({ code: "order", blocking: [restart] }), () => ({
        id: 40,
        status: "done",
        running: false,
      })),
    );
    await runStep2();
    await screen.findByText(locales.order.title);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "Not done yet: 1. Restart. Run this step anyway?",
    );
    await pick(locales.order.anyway);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenLastCalledWith("/steps/2/run", {
        revision: 1,
        commandHash: "b".repeat(64),
        outOfOrder: true,
      }),
    );
    expect(client.post).toHaveBeenCalledTimes(2);
  });

  it("does not run on a no to the order question", async () => {
    const client = await open(
      answers(conflict({ code: "order", blocking: [restart] })),
    );
    await runStep2();
    await screen.findByText(locales.order.title);
    fireEvent.keyDown(window, { key: "Escape" });
    await vi.waitFor(() =>
      expect(screen.queryByRole("alertdialog")).toBeNull(),
    );
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it("says a changed step is stale and reads the runbook again", async () => {
    const error = vi.spyOn(toast, "error");
    const client = await open(answers(conflict({ code: "stale" })));
    const before = gets(client);
    await runStep2();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(locales.error.stale),
    );
    await vi.waitFor(() => expect(gets(client)).toBeGreaterThan(before));
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it("shows the server's words for any other refusal", async () => {
    const error = vi.spyOn(toast, "error");
    await open(answers({ response: { status: 400, data: { error: "no" } } }));
    await runStep2();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("no"));
  });
});

describe("a Make it the server refuses", () => {
  const make = () =>
    fireEvent.click(card(4).querySelector("[data-make-secret]")!);

  it("asks about the order in its own words", async () => {
    const client = await open(
      answers(conflict({ code: "order", blocking: [restart] })),
    );
    make();
    await screen.findByText(locales.order.title);
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "Not done yet: 1. Restart. Do this step anyway?",
    );
    await pick(locales.secretStep.orderAnyway);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenLastCalledWith("/steps/4/secret", {
        revision: 2,
        outOfOrder: true,
      }),
    );
  });

  it("asks about a wait with the time and the reason", async () => {
    const client = await open(
      answers(
        conflict({
          code: "wait",
          remainingSeconds: 75,
          reason: "let it settle",
        }),
      ),
    );
    make();
    await screen.findByText("The wait is not over: 1:15 left (let it settle)");
    await pick(locales.wait.anyway);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenLastCalledWith("/steps/4/secret", {
        revision: 2,
        waitAnyway: true,
      }),
    );
  });

  it("says a changed step is stale and reads the runbook again", async () => {
    const error = vi.spyOn(toast, "error");
    const client = await open(answers(conflict({ code: "stale" })));
    const before = gets(client);
    make();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(locales.error.stale),
    );
    await vi.waitFor(() => expect(gets(client)).toBeGreaterThan(before));
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it("reads the runbook again after any other 409", async () => {
    const error = vi.spyOn(toast, "error");
    const client = await open(
      answers({ response: { status: 409, data: { error: "by hand now" } } }),
    );
    const before = gets(client);
    make();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("by hand now"));
    await vi.waitFor(() => expect(gets(client)).toBeGreaterThan(before));
  });
});

describe("step and runbook actions", () => {
  /** The runbook with step `id` changed by `change`. */
  const changed = (id: number, change: Partial<Step>) => {
    const data = runbook();
    data.steps = data.steps.map((step) =>
      step.id === id ? { ...step, ...change } : step,
    );
    return data;
  };

  it("Skip sends the reason and shows the answer", async () => {
    const client = await open(
      answers(changed(1, { status: "skipped", skipReason: "not needed" })),
    );
    fireEvent.click(within(card(1)).getByText(locales.step.skip));
    fireEvent.change(
      within(card(1)).getByPlaceholderText(locales.step.skipReason),
      { target: { value: "not needed" } },
    );
    const skips = within(card(1)).getAllByText(locales.step.skip);
    fireEvent.click(skips[skips.length - 1]);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/1/skip", {
        reason: "not needed",
      }),
    );
    await vi.waitFor(() =>
      expect(card(1).textContent).toContain("Skipped: not needed"),
    );
  });

  it("Reopen posts with no body and shows the answer", async () => {
    const client = await open(answers(changed(3, { status: "pending" })));
    fireEvent.click(within(card(3)).getByText(locales.step.reopen));
    await vi.waitFor(() =>
      expect(client.post.mock.calls[0]).toEqual(["/steps/3/reopen"]),
    );
    await vi.waitFor(() =>
      expect(within(card(3)).queryByText(locales.step.reopen)).toBeNull(),
    );
  });

  it("Hide output from agents posts the flag and shows the answer", async () => {
    const client = await open(
      answers(changed(1, { hideOutputFromAgents: true })),
    );
    fireEvent.click(within(card(1)).getByText(locales.step.hideFromAgents));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/1/hide", {
        hidden: true,
      }),
    );
    await vi.waitFor(() =>
      expect(within(card(1)).getByText(locales.step.hidden)).toBeTruthy(),
    );
  });

  it("a note is saved when the box loses the focus, then read again", async () => {
    const client = await open(async () => ({ data: {} }));
    const before = gets(client);
    const box = within(card(1)).getByPlaceholderText(
      locales.step.notesPlaceholder,
    );
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "checked" } });
    fireEvent.blur(box);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/1/note", {
        ownerNote: "checked",
      }),
    );
    await vi.waitFor(() => expect(gets(client)).toBeGreaterThan(before));
    // Saving a note never makes the buttons wait.
    expect(
      within(card(1)).getByText(locales.step.skip).closest("button")!.disabled,
    ).toBe(false);
  });

  it("Mark done and Reopen set the runbook's status", async () => {
    let status: Runbook["status"] = "open";
    const client = await open(async (_url, body) => {
      status = (body as { status: Runbook["status"] }).status;
      return { data: runbook({ status }) };
    });
    fireEvent.click(screen.getByText(locales.runbook.markDone));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/runbooks/7/status", {
        status: "done",
      }),
    );
    // Closed: the steps have no buttons, so Reopen is the runbook's.
    await vi.waitFor(() =>
      expect(screen.queryByText(locales.runbook.markDone)).toBeNull(),
    );
    fireEvent.click(screen.getByText(locales.runbook.reopen));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenLastCalledWith("/runbooks/7/status", {
        status: "open",
      }),
    );
    fireEvent.click(await screen.findByText(locales.runbook.abandon));
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenLastCalledWith("/runbooks/7/status", {
        status: "abandoned",
      }),
    );
  });

  it("a refused action shows the server's words, or a general one", async () => {
    const error = vi.spyOn(toast, "error");
    let calls = 0;
    await open(async () => {
      calls += 1;
      throw {
        response: {
          status: 400,
          data: calls === 1 ? { error: "step is closed" } : {},
        },
      };
    });
    fireEvent.click(within(card(1)).getByText(locales.step.hideFromAgents));
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith("step is closed"),
    );
    const hide = within(card(1))
      .getByText(locales.step.hideFromAgents)
      .closest("button")!;
    await vi.waitFor(() => expect(hide.disabled).toBe(false));
    fireEvent.click(hide);
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(locales.error.generic),
    );
  });
});
