/**
 * What the frontend tests share: the plugin rendered in a fake Termix app,
 * builders for what the server sends, a fake of its routes, and ways to
 * find a step's card. The builders use the page's own types, so a fixture
 * cannot leave out a field the page reads.
 */

import { afterEach, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
  type RenderWithAppOptions,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import type {
  Run,
  Runbook,
  RunbookListEntry,
  RunbookSummary,
  Step,
} from "../../src/frontend/api-types";
import { stepLabel } from "../../src/shared/steps";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

export { locales };
export const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;
let registered = false;

/** Everything renderWithApp takes but the plugin, its manifest and locales. */
export type RenderOptions = Omit<
  RenderWithAppOptions,
  "api" | "manifest" | "locales"
>;

/** Renders the plugin with `api` as its routes. See useRenderedApp. */
async function renderApp(
  api: unknown,
  options: RenderOptions = {},
): Promise<RenderedPluginApp> {
  if (!registered) {
    throw new Error("call useRenderedApp() at the top of the test file");
  }
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api: api as never,
    ...options,
  });
  return rendered;
}

/**
 * Call once at the top of a test file. After each test the clock is real
 * again (a test may have faked it) and the rendered app is deactivated.
 * Returns render(api, options?).
 */
export function useRenderedApp(): typeof renderApp {
  registered = true;
  afterEach(async () => {
    vi.useRealTimers();
    await rendered?.deactivate();
    rendered = null;
  });
  return renderApp;
}

/**
 * Renders the Runbooks tab, clicks the runbook called `title`, and waits
 * until it shows: for the heading `shows`, or for `shows()` to resolve.
 * Under fake timers the clock moves instead of waiting.
 */
export async function openRunbook(
  api: unknown,
  {
    title,
    shows,
    fakeTimers = false,
    ...options
  }: RenderOptions & {
    title: string;
    shows?: string | (() => Promise<unknown>);
    fakeTimers?: boolean;
  },
): Promise<RenderedPluginApp> {
  const app = await renderApp(api, options);
  app.renderTab("runbooks", { isVisible: true });
  if (fakeTimers) {
    await flush();
    fireEvent.click(screen.getByText(title));
    await flush();
    return app;
  }
  fireEvent.click(await screen.findByText(title));
  if (typeof shows === "string") {
    await screen.findByRole("heading", { name: shows });
  } else if (shows) {
    await shows();
  }
  return app;
}

/** Lets promises and due timers run under fake timers. */
export const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

/** A step's card by its id. */
export const card = (id: number) =>
  document.querySelector(`[data-step="${id}"]`) as HTMLElement;

/** The text of each button on a step's card. */
export const buttons = (id: number) =>
  [...card(id).querySelectorAll("button")].map((button) => button.textContent);

/** A step card's kind chip. */
export const chip = (id: number) =>
  card(id).querySelector("[data-kind]:not([data-step])") as HTMLElement;

/** A runbook's own fields, as every view of it sends them. */
const SUMMARY: RunbookSummary = {
  id: 7,
  title: "Runbook",
  status: "open",
  createdBy: "lead",
  createdAt: "2026-11-07T10:00:00.000Z",
  updatedAt: "2026-11-07T10:05:00.000Z",
  revision: 4,
  progress: { done: 1, failed: 0, total: 3 },
  amendedPending: 0,
};

/** A runbook in the list, as GET /runbooks sends it. */
export function makeSummary(
  overrides: Partial<RunbookListEntry> = {},
): RunbookListEntry {
  return { ...SUMMARY, nextKind: null, ...overrides };
}

/** A pending command step on web-1, as GET /runbooks/:id sends it. */
export function makeStep(overrides: Partial<Step> & { id: number }): Step {
  const position = overrides.position ?? overrides.id;
  const suffix = overrides.suffix ?? null;
  const body = overrides.body ?? "";
  const expect = overrides.expect ?? "";
  const where = overrides.where ?? null;
  return {
    runbookId: 7,
    position,
    suffix,
    label: stepLabel({ position, suffix }),
    amendment: null,
    replacedBy: null,
    title: `Step ${overrides.id}`,
    body,
    where,
    hostId: 1,
    hostName: "web-1",
    command: "true",
    resolvedCommand: "true",
    commandHash: "a".repeat(64),
    missing: [],
    expect,
    resolvedBody: body,
    resolvedExpect: expect,
    resolvedWhere: where,
    textMissing: [],
    captures: [],
    checks: [],
    hideOutputFromAgents: false,
    status: "pending",
    skipReason: null,
    ownerNote: "",
    timeoutMs: null,
    waitAfterPreviousSeconds: null,
    waitReason: null,
    wait: null,
    stdin: null,
    secretCaptures: [],
    secretsProblem: null,
    owner: "person",
    generate: null,
    ask: null,
    secretStep: null,
    sent: [],
    revision: 1,
    runs: [],
    ...overrides,
  };
}

/** A pending step with no command: the person clicks Done or Failed. */
export function clickStep(overrides: Partial<Step> & { id: number }): Step {
  return makeStep({
    hostId: null,
    hostName: null,
    command: null,
    resolvedCommand: null,
    commandHash: null,
    ...overrides,
  });
}

/** A Run that ended done with exit code 0 and no output. */
export function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 21,
    stepId: 1,
    runbookId: 7,
    mode: "exec",
    status: "done",
    hostId: 1,
    command: "true",
    commandHash: "a".repeat(64),
    userId: "alice",
    startedAt: "2026-11-07T10:01:00.000Z",
    finishedAt: "2026-11-07T10:01:02.000Z",
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    pastedOutput: null,
    error: null,
    captured: {},
    checks: null,
    stdin: null,
    secrets: null,
    note: null,
    startedEarlySeconds: null,
    running: false,
    lastOutputAt: null,
    elapsedMs: null,
    silentMs: null,
    ...overrides,
  };
}

/**
 * An open runbook with `steps`, as GET /runbooks/:id sends it. The next
 * step is the first pending one unless `overrides` says otherwise. As on
 * the server, agentLabel is the owner's label, or who made it.
 */
export function makeRunbook(
  steps: Step[],
  overrides: Partial<Runbook> = {},
): Runbook {
  const owner = overrides.owner ?? null;
  return {
    ...SUMMARY,
    summary: "",
    values: {},
    effectiveValues: [],
    nextStepId: steps.find((step) => step.status === "pending")?.id ?? null,
    owner,
    agentLabel: owner?.label ?? overrides.createdBy ?? SUMMARY.createdBy,
    notifyEnabled: false,
    canSendToAgent: false,
    secretsAvailable: false,
    secrets: [],
    steps,
    ...overrides,
  };
}

/** The list fields of a runbook, as GET /runbooks sends them. */
export function summaryOf(
  runbook: Runbook,
  nextKind: string | null = null,
): RunbookListEntry {
  const {
    id,
    title,
    status,
    createdBy,
    createdAt,
    updatedAt,
    revision,
    progress,
    amendedPending,
  } = runbook;
  return {
    id,
    title,
    status,
    createdBy,
    createdAt,
    updatedAt,
    revision,
    progress,
    amendedPending,
    nextKind,
  };
}

type Reply = Promise<{ data: unknown }>;

/**
 * The plugin's routes, faked: GET /runbooks answers `list` (default: the
 * detail's list fields), GET /colors answers `colors` (default none) and
 * any other GET the runbook. POST answers `post`, or the runbook.
 */
export function fakeApi(options: {
  list?: RunbookListEntry[];
  detail: Runbook | (() => Runbook);
  colors?: unknown;
  post?: (url: string, body?: unknown) => Promise<unknown>;
}) {
  const detail =
    typeof options.detail === "function"
      ? options.detail
      : () => options.detail as Runbook;
  return {
    get: vi.fn(async (url: string): Reply => ({
      data:
        url === "/runbooks"
          ? (options.list ?? [summaryOf(detail())])
          : url === "/colors"
            ? (options.colors ?? {})
            : detail(),
    })),
    post: vi.fn(
      (options.post as (url: string, body?: unknown) => Reply) ??
        (async (): Reply => ({ data: detail() })),
    ),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

export type FakeApi = ReturnType<typeof fakeApi>;
