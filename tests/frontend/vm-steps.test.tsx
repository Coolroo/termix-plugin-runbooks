import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  card,
  flush,
  clickStep,
  fakeApi,
  locales,
  makeRun,
  makeRunbook,
  makeSummary,
  openRunbook,
  useRenderedApp,
} from "./helpers";
import type { Runbook, Step } from "../../src/frontend/api-types";
import type { VmSpec, VmStepState } from "../../src/shared/vms";

useRenderedApp();

afterEach(() => {
  vi.restoreAllMocks();
});

const SPEC: VmSpec = {
  host: 1,
  name: "build-1",
  action: "start",
  force: false,
  waitFor: "running",
  waitSeconds: 300,
  value: "build",
};

const vmStep = (
  overrides: Partial<Step> & { id: number },
  vm: Partial<VmSpec> = {},
) =>
  clickStep({
    title: "Start the build VM",
    vm: { ...SPEC, ...vm },
    vmHostName: "host-1",
    vmProblem: null,
    ...overrides,
  });

const READY: VmStepState = {
  ready: true,
  reason: null,
  code: null,
  role: "operator",
  hostName: "host-1",
  refused: null,
  at: "2026-11-18T10:00:00.000Z",
  vm: {
    name: "build-1",
    id: "id-build-1",
    state: "off",
    cpus: 4,
    memoryMB: 8192,
    uptimeSeconds: 0,
    addresses: [],
    allowed: true,
    protected: false,
  },
};

const summary = makeSummary({ title: "Build" });

async function open(
  detail: Runbook,
  options: {
    state?: VmStepState;
    post?: (url: string, body?: unknown) => Promise<unknown>;
    hosts?: Array<Record<string, unknown>>;
  } = {},
) {
  const client = fakeApi({
    list: [summary],
    detail,
    post: options.post,
    get: (url) => (url.endsWith("/vm") ? (options.state ?? READY) : undefined),
  });
  const app = await openRunbook(client, {
    title: "Build",
    shows: detail.steps[0].title,
    hosts: options.hosts,
  });
  return { client, app };
}

const vmButton = (id: number) =>
  card(id).querySelector("[data-vm-button]") as HTMLButtonElement;

/** Clicks the button in the open confirm whose text starts with `label`. */
async function pick(label: string) {
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(
    within(dialog)
      .getAllByRole("button")
      .find((button) => button.textContent?.startsWith(label))!,
  );
}

describe("VM steps on the page (T-029)", () => {
  it("shows the host, the VM's state now and one button named for the action", async () => {
    const { client } = await open(
      makeRunbook([vmStep({ id: 1 })], { title: "Build" }),
    );
    const box = card(1);
    expect(box.getAttribute("data-kind")).toBe("vm");
    await vi.waitFor(() =>
      expect(
        box.querySelector("[data-vm-state]")?.getAttribute("data-vm-state"),
      ).toBe("off"),
    );
    expect(client.get).toHaveBeenCalledWith("/steps/1/vm");
    expect(within(box).getByText("VM on host-1")).toBeTruthy();
    expect(box.querySelector("[data-vm-does]")!.textContent).toContain(
      "Starts build-1.",
    );
    expect(box.querySelector("[data-vm-does]")!.textContent).toContain(
      "running",
    );
    expect(box.querySelector("[data-vm-values]")!.textContent).toContain(
      "{{build.ip}}",
    );
    expect(vmButton(1).textContent).toBe(locales.vm.button.start);
    expect(vmButton(1).disabled).toBe(false);
    // No Done or Failed, Run or Send: the button is the step.
    expect(within(box).queryByText(locales.step.done)).toBeNull();
    expect(within(box).queryByText(locales.step.run)).toBeNull();
  });

  it("says the host refuses before anything is pressed", async () => {
    await open(
      makeRunbook([vmStep({ id: 1 }, { action: "stop", waitFor: "off" })], {
        title: "Build",
      }),
      {
        state: {
          ...READY,
          refused:
            "the host refuses this: build-1 is on the host's protect list",
        },
      },
    );
    await vi.waitFor(() =>
      expect(card(1).querySelector("[data-vm-refused]")).toBeTruthy(),
    );
    expect(card(1).querySelector("[data-vm-refused]")!.textContent).toContain(
      "protect list",
    );
    expect(vmButton(1).textContent).toBe(locales.vm.button.stop);
    expect(vmButton(1).disabled).toBe(true);
  });

  it("says why it cannot run: HAW refuses Runbooks, or HAW is not there", async () => {
    await open(makeRunbook([vmStep({ id: 1 })], { title: "Build" }), {
      state: {
        ...READY,
        ready: false,
        vm: null,
        code: "plugin-not-allowed",
        reason:
          'Runbooks may not act for people in HAW yet: an admin adds "runbooks" to "Plugins that may act for a person" in HAW\'s settings',
      },
    });
    await vi.waitFor(() =>
      expect(
        card(1)
          .querySelector("[data-vm-problem]")
          ?.getAttribute("data-vm-problem"),
      ).toBe("plugin-not-allowed"),
    );
    expect(vmButton(1).disabled).toBe(true);
  });

  it("does not ask HAW when HAW is not installed", async () => {
    const { client } = await open(
      makeRunbook(
        [vmStep({ id: 1, vmProblem: "Install HAW VM Manager 1.0.3 or later" })],
        {
          title: "Build",
        },
      ),
    );
    expect(card(1).querySelector("[data-vm-problem]")!.textContent).toContain(
      "Install HAW",
    );
    expect(client.get).not.toHaveBeenCalledWith("/steps/1/vm");
    expect(vmButton(1).disabled).toBe(true);
  });

  it("asks, then presses with the revision it showed", async () => {
    const detail = makeRunbook([vmStep({ id: 1 })], { title: "Build" });
    const { client } = await open(detail, {
      post: async () => ({
        data: {
          run: makeRun({ mode: "vm", status: "running", running: true }),
          consoleHost: null,
        },
      }),
    });
    await vi.waitFor(() =>
      expect(card(1).querySelector("[data-vm-state]")).toBeTruthy(),
    );
    fireEvent.click(vmButton(1));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("build-1");
    expect(dialog.textContent).toContain(locales.vm.asYou);
    await pick(locales.vm.button.start);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/1/vm", { revision: 1 }),
    );
  });

  it("shows force in red and asks about it on its own", async () => {
    const posts: unknown[] = [];
    const detail = makeRunbook(
      [vmStep({ id: 1 }, { action: "stop", force: true, waitFor: "off" })],
      {
        title: "Build",
      },
    );
    const { client } = await open(detail, {
      post: async (_url, body) => {
        posts.push(body);
        if (!(body as { confirmForce?: boolean }).confirmForce) {
          throw {
            response: {
              status: 409,
              data: {
                error: "turn off build-1?",
                code: "force",
                action: "stop",
                name: "build-1",
              },
            },
          };
        }
        return { data: { run: makeRun({ mode: "vm" }), consoleHost: null } };
      },
    });
    await vi.waitFor(() =>
      expect(card(1).querySelector("[data-vm-state]")).toBeTruthy(),
    );
    expect(vmButton(1).textContent).toBe(locales.vm.button.stopForce);
    expect(vmButton(1).getAttribute("data-force")).toBe("true");
    expect(card(1).querySelector("[data-vm-does]")!.className).toContain(
      "text-destructive",
    );
    fireEvent.click(vmButton(1));
    await pick(locales.vm.button.stopForce);
    const second = await screen.findByRole("alertdialog");
    await vi.waitFor(() =>
      expect(second.textContent).toContain(
        "Turn off build-1 without a shutdown?",
      ),
    );
    await pick(locales.vm.button.stopForce);
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ revision: 1, confirmForce: true });
    expect(client.post).toHaveBeenCalledTimes(2);
  });

  it("shows the state as it changes while it waits", async () => {
    await open(
      makeRunbook(
        [
          vmStep({
            id: 1,
            runs: [
              makeRun({
                mode: "vm",
                status: "running",
                running: true,
                finishedAt: null,
                stdout: "Starting build-1…\nbuild-1 is starting\n",
                elapsedMs: 12_000,
              }),
            ],
          }),
        ],
        { title: "Build" },
      ),
    );
    const waiting = card(1).querySelector("[data-vm-waiting]")!;
    expect(waiting.textContent).toContain("Waiting until it is running:");
    expect(waiting.textContent).toContain("build-1 is starting");
    expect(vmButton(1).disabled).toBe(true);
  });

  it("opens the console in Remote Desktop and ends with Done", async () => {
    const detail = makeRunbook(
      [vmStep({ id: 1 }, { action: "console", waitFor: null, value: null })],
      {
        title: "Build",
      },
    );
    let consoleRun = false;
    const withRun = () =>
      consoleRun
        ? makeRunbook(
            [
              vmStep(
                {
                  id: 1,
                  runs: [
                    makeRun({
                      mode: "vm",
                      status: "awaiting-output",
                      finishedAt: null,
                    }),
                  ],
                },
                { action: "console", waitFor: null, value: null },
              ),
            ],
            { title: "Build" },
          )
        : detail;
    const client = fakeApi({
      list: [summary],
      detail: withRun,
      get: (url) => (url.endsWith("/vm") ? READY : undefined),
      post: async (url) => {
        if (url === "/steps/1/vm") {
          consoleRun = true;
          return {
            data: {
              run: makeRun({ mode: "vm", status: "awaiting-output" }),
              consoleHost: { id: 3, name: "host-3" },
            },
          };
        }
        return { data: withRun() };
      },
    });
    const app = await openRunbook(client, {
      title: "Build",
      shows: "Start the build VM",
      hosts: [{ id: 3, name: "host-3", ip: "10.0.0.3" }],
    });
    expect(vmButton(1).textContent).toBe(locales.vm.button.console);
    fireEvent.click(vmButton(1));
    await pick(locales.vm.button.console);
    await vi.waitFor(() =>
      expect(
        app.shellCalls.some(
          (call) => call.method === "openTab" && call.args[1] === "rdp",
        ),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(card(1).querySelector("[data-vm-console-open]")).toBeTruthy(),
    );
    fireEvent.click(card(1).querySelector('[data-vm-end="done"]')!);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/1/vm/end", {
        outcome: "done",
      }),
    );
  });
});

const NOT_FOUND: VmStepState = {
  ...READY,
  ready: false,
  vm: null,
  code: "not-found",
  reason: "no VM is named build-1",
};

/** How many times the card read step `id`'s VM. */
const reads = (client: { get: { mock: { calls: unknown[][] } } }, id = 2) =>
  client.get.mock.calls.filter(([url]) => url === `/steps/${id}/vm`).length;

/** The browser tab shows again. */
function showPage() {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("the VM step reads its VM again (BUG-017)", () => {
  afterEach(() => {
    // jsdom's own visibilityState again.
    delete (document as { visibilityState?: string }).visibilityState;
  });

  it("reads again when an earlier step's run ends", async () => {
    let made = false;
    const detail = () =>
      makeRunbook(
        [
          clickStep({
            id: 1,
            title: "Make the VM",
            status: made ? "done" : "pending",
            runs: made
              ? [
                  makeRun({
                    id: 40,
                    stepId: 1,
                    mode: "manual",
                    finishedAt: "2026-11-20T10:00:00.000Z",
                  }),
                ]
              : [],
          }),
          vmStep({ id: 2 }),
        ],
        { title: "Build" },
      );
    const client = fakeApi({
      list: [summary],
      detail,
      get: (url) =>
        url === "/steps/2/vm" ? (made ? READY : NOT_FOUND) : undefined,
      post: async () => {
        made = true;
        return { data: detail() };
      },
    });
    await openRunbook(client, { title: "Build", shows: "Make the VM" });
    await vi.waitFor(() => expect(card(2).getAttribute("data-step")).toBe("2"));
    await vi.waitFor(() =>
      expect(card(2).querySelector("[data-vm-alert]")).toBeTruthy(),
    );
    expect(vmButton(2).disabled).toBe(true);
    expect(reads(client)).toBe(1);

    fireEvent.click(card(1).querySelector('[data-manual="done"]')!);
    await vi.waitFor(() =>
      expect(
        card(2).querySelector("[data-vm-state]")?.getAttribute("data-vm-state"),
      ).toBe("off"),
    );
    expect(reads(client)).toBe(2);
    expect(card(2).querySelector("[data-vm-alert]")).toBeNull();
    expect(vmButton(2).disabled).toBe(false);
  });

  it("shows a VM that is not there in a box with the time and Read again", async () => {
    const client = fakeApi({
      list: [summary],
      detail: makeRunbook([vmStep({ id: 2 })], { title: "Build" }),
      get: (url) => (url.endsWith("/vm") ? NOT_FOUND : undefined),
    });
    await openRunbook(client, { title: "Build", shows: "Start the build VM" });
    const box = await vi.waitFor(() => {
      const found = card(2).querySelector("[data-vm-alert]") as HTMLElement;
      expect(found).toBeTruthy();
      return found;
    });
    expect(box.getAttribute("role")).toBe("alert");
    expect(box.getAttribute("data-vm-alert")).toBe("not-found");
    expect(box.textContent).toContain("no VM is named build-1");
    expect(box.querySelector("[data-vm-alert-time]")!.textContent).toMatch(
      /^Read at .+\. An earlier step may have made or changed this VM since/,
    );
    // The one Read again is the box's, a real button with its name.
    const again = within(box).getByRole("button", {
      name: locales.vm.readAgain,
    });
    expect(card(2).querySelectorAll("[data-vm-read]")).toHaveLength(1);
    expect(card(2).querySelector("[data-vm-age]")).toBeNull();
    fireEvent.click(again);
    await vi.waitFor(() => expect(reads(client)).toBe(2));
  });

  it("shows a failed read in the box too", async () => {
    const client = fakeApi({
      list: [summary],
      detail: makeRunbook([vmStep({ id: 2 })], { title: "Build" }),
    });
    client.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/vm")) {
        throw { response: { status: 502, data: { error: "HAW is down" } } };
      }
      return {
        data:
          url === "/runbooks"
            ? [summary]
            : makeRunbook([vmStep({ id: 2 })], { title: "Build" }),
      };
    });
    await openRunbook(client, { title: "Build", shows: "Start the build VM" });
    const box = await vi.waitFor(() => {
      const found = card(2).querySelector("[data-vm-alert]") as HTMLElement;
      expect(found).toBeTruthy();
      return found;
    });
    expect(box.getAttribute("data-vm-alert")).toBe("read-error");
    expect(box.textContent).toContain("HAW is down");
    expect(
      within(box).getByRole("button", { name: locales.vm.readAgain }),
    ).toBeTruthy();
  });

  it("puts Read again next to the state as an outlined button, with the read's age", async () => {
    vi.useFakeTimers();
    const client = fakeApi({
      list: [summary],
      detail: makeRunbook([vmStep({ id: 2 })], { title: "Build" }),
      get: (url) => (url.endsWith("/vm") ? READY : undefined),
    });
    await openRunbook(client, { title: "Build", fakeTimers: true });
    await flush();
    const row = card(2).querySelector("[data-vm-target]") as HTMLElement;
    const again = within(row).getByRole("button", {
      name: locales.vm.readAgain,
    });
    expect(again.tagName).toBe("BUTTON");
    expect(again.className).toContain("border");
    expect(again.querySelector("svg")).toBeTruthy();
    expect(row.querySelector("[data-vm-age]")!.textContent).toBe(
      locales.vm.readJustNow,
    );
    await flush(3 * 60_000);
    expect(row.querySelector("[data-vm-age]")!.textContent).toBe(
      "read 3 min ago",
    );
  });

  it("reads again when the page shows again after a minute, not before", async () => {
    vi.useFakeTimers();
    const client = fakeApi({
      list: [summary],
      detail: makeRunbook([vmStep({ id: 2 })], { title: "Build" }),
      get: (url) => (url.endsWith("/vm") ? READY : undefined),
    });
    await openRunbook(client, { title: "Build", fakeTimers: true });
    await flush();
    expect(reads(client)).toBe(1);
    await flush(30_000);
    showPage();
    await flush();
    expect(reads(client)).toBe(1);
    await flush(31_000);
    showPage();
    showPage();
    await flush();
    // One read for both: the second came while the first was in flight.
    expect(reads(client)).toBe(2);
    expect(card(2).querySelector("[data-vm-age]")!.textContent).toBe(
      locales.vm.readJustNow,
    );
  });

  it("keeps one read in flight, and reads once more after it", async () => {
    let made = false;
    let answer: (state: VmStepState) => void = () => {};
    const detail = () =>
      makeRunbook(
        [
          clickStep({
            id: 1,
            title: "Make the VM",
            status: made ? "done" : "pending",
            runs: made ? [makeRun({ id: 40, stepId: 1, mode: "manual" })] : [],
          }),
          vmStep({ id: 2 }),
        ],
        { title: "Build" },
      );
    const client = fakeApi({
      list: [summary],
      detail,
      post: async () => {
        made = true;
        return { data: detail() };
      },
    });
    const fallback = client.get.getMockImplementation()!;
    client.get.mockImplementation(async (url: string) =>
      url === "/steps/2/vm"
        ? { data: await new Promise<VmStepState>((done) => (answer = done)) }
        : fallback(url),
    );
    await openRunbook(client, { title: "Build", shows: "Make the VM" });
    await vi.waitFor(() => expect(reads(client)).toBe(1));
    await vi.waitFor(() =>
      expect(card(2).querySelector("[data-vm-reading]")).toBeTruthy(),
    );
    // Step 1 ends while the first read is in flight: no second request yet.
    fireEvent.click(card(1).querySelector('[data-manual="done"]')!);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/1/manual", {
        outcome: "done",
        note: "",
      }),
    );
    expect(reads(client)).toBe(1);
    answer(NOT_FOUND);
    await vi.waitFor(() => expect(reads(client)).toBe(2));
    answer(READY);
    await vi.waitFor(() =>
      expect(card(2).querySelector("[data-vm-state]")).toBeTruthy(),
    );
    expect(reads(client)).toBe(2);
  });
});
