import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  card,
  chip,
  clickStep,
  fakeApi,
  locales,
  makeRun,
  makeRunbook,
  openRunbook,
  useRenderedApp,
} from "./helpers";
import type { SecretStepView, Step } from "../../src/frontend/api-types";

useRenderedApp();

afterEach(() => {
  vi.restoreAllMocks();
});

const step = (overrides: Partial<Step> & { id: number }) =>
  clickStep({
    revision: 3,
    owner: "person",
    where: null,
    generate: null,
    ask: null,
    secretStep: null,
    ...overrides,
  });

const ready = (kind: "generate" | "ask", name: string): SecretStepView => ({
  kind,
  name,
  mode: "ready",
  reason: null,
  byHand: { engine: "kv", path: "runbooks/7", field: name },
  set: false,
  expiresAt: null,
});

const data = makeRunbook(
  [
    step({
      id: 1,
      title: "Made before",
      status: "done",
      generate: {
        name: "old_pw",
        format: "alnum",
        length: 32,
        store: "runbook",
      },
      secretStep: {
        ...ready("generate", "old_pw"),
        set: true,
        expiresAt: "2026-11-17T10:00:00.000Z",
      },
      runs: [
        makeRun({
          id: 50,
          mode: "secret",
          hostId: null,
          command: "",
          commandHash: "",
          startedAt: "2026-11-10T10:01:00.000Z",
          finishedAt: "2026-11-10T10:01:00.000Z",
          exitCode: null,
          stdout: null,
          stderr: null,
          secrets: {
            used: [],
            captured: [
              { name: "old_pw", expiresAt: "2026-11-17T10:00:00.000Z" },
            ],
            made: {
              name: "old_pw",
              how: "made",
              store: "runbook",
              where: null,
              expiresAt: "2026-11-17T10:00:00.000Z",
            },
          },
        }),
      ],
    }),
    step({
      id: 2,
      title: "Make the database password",
      generate: {
        name: "db_password",
        format: "words",
        length: 6,
        store: "runbook",
      },
      secretStep: ready("generate", "db_password"),
    }),
    step({
      id: 3,
      title: "Paste the API token",
      ask: {
        name: "api_token",
        label: "API token",
        pattern: "[A-Za-z0-9]{20}",
        store: { library: "mine/cf" },
      },
      secretStep: ready("ask", "api_token"),
    }),
    step({
      id: 4,
      title: "Make the app token",
      generate: {
        name: "app_token",
        format: "hex",
        length: 64,
        store: { app: "web/host-1", field: "token" },
      },
      secretStep: {
        ...ready("generate", "app_token"),
        mode: "by-hand",
        reason: "Install and connect the OpenBao Secrets plugin to use secrets",
        byHand: {
          engine: "kv",
          path: "<app secrets folder>/web/host-1",
          field: "token",
        },
      },
    }),
    step({
      id: 5,
      title: "Log in",
      hostId: 1,
      hostName: "web-1",
      command: "login --password-stdin",
      resolvedCommand: "login --password-stdin",
      commandHash: "abc",
      stdin: {
        source: { from: "secret", name: "db_password" },
        bytes: null,
        preview: null,
        problem:
          "Install and connect the OpenBao Secrets plugin to use secrets",
        byHand: {
          engine: "kv",
          path: "runbooks/7",
          field: "db_password",
          step: "2",
        },
      },
    }),
  ],
  {
    title: "Secrets",
    createdAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T10:05:00.000Z",
    progress: { done: 1, failed: 0, total: 5 },
    nextStepId: 2,
    owner: null,
    agentLabel: "lead",
    secretsAvailable: true,
    secrets: [],
  },
);

const api = (post?: (url: string, body: unknown) => Promise<unknown>) =>
  fakeApi({
    detail: data,
    post,
  });

async function open(client = api()) {
  await openRunbook(client, {
    title: "Secrets",
    shows: "Make the database password",
  });
  return client;
}

describe("secret steps", () => {
  it("draw their own kinds: icon, label and color", async () => {
    await open();
    for (const [id, kind, label] of [
      [2, "make-secret", locales.kind.makeSecret],
      [3, "ask-secret", locales.kind.askSecret],
      [4, "make-secret", locales.kind.makeSecret],
    ] as const) {
      expect(card(id).getAttribute("data-kind")).toBe(kind);
      expect(chip(id).textContent).toBe(label);
      expect(chip(id).querySelector("svg")).not.toBeNull();
    }
    // The current step's border is its kind's color (fuchsia, the test
    // host's dark theme).
    expect(card(2).style.borderColor).toBe("rgb(232, 121, 249)");
  });

  it("Make it sends only the revision: the value is made on the server", async () => {
    const client = await open();
    const body = card(2).querySelector('[data-secret-step="generate"]')!;
    expect(body.querySelector("[data-secret-what]")!.textContent).toBe(
      "Make secret db_password: a passphrase of 6 words from the EFF long word list, joined by -",
    );
    expect(body.querySelector("[data-secret-store]")!.textContent).toContain(
      "the runbook's secrets for 7 days",
    );
    // Make a secret has no Done or Failed of its own: Make it is the action.
    expect(card(2).querySelector("[data-manual]")).toBeNull();
    fireEvent.click(body.querySelector("[data-make-secret]")!);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/2/secret", {
        revision: 3,
      }),
    );
  });

  it("Ask shows what is typed, hides it on Hide without changing it, and saves it once", async () => {
    const client = await open();
    const body = card(3).querySelector('[data-secret-step="ask"]')!;
    const field = body.querySelector(
      "[data-secret-value]",
    ) as HTMLTextAreaElement;
    const save = body.querySelector("[data-save-secret]") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(body.querySelector("[data-ask-pattern]")!.textContent).toBe(
      "It must match: [A-Za-z0-9]{20}",
    );
    expect(body.querySelector("[data-secret-store]")!.textContent).toContain(
      "your secrets in OpenBao Secrets: cf",
    );
    fireEvent.change(field, { target: { value: "abcdEFGH1234abcdEFGH" } });
    expect(field.value).toBe("abcdEFGH1234abcdEFGH");
    expect(field.getAttribute("data-hidden")).toBe("false");
    fireEvent.click(
      within(body as HTMLElement).getByText(locales.secretStep.hide),
    );
    expect(field.getAttribute("data-hidden")).toBe("true");
    expect(field.value).toBe("abcdEFGH1234abcdEFGH");
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/3/secret", {
        revision: 3,
        value: "abcdEFGH1234abcdEFGH",
      }),
    );
    // Saved: the field is empty again.
    await vi.waitFor(() =>
      expect(
        (card(3).querySelector("[data-secret-value]") as HTMLTextAreaElement)
          .value,
      ).toBe(""),
    );
  });

  it("asks before making a new value over one made already", async () => {
    let calls = 0;
    const client = await open(
      api(async () => {
        calls += 1;
        if (calls === 1) {
          throw {
            response: {
              status: 409,
              data: {
                error: "step 2 made secret db_password already",
                code: "repeat",
              },
            },
          };
        }
        return { data };
      }),
    );
    fireEvent.click(card(2).querySelector("[data-make-secret]")!);
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        "Step made secret db_password already. Make a new value?",
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog)
        .getAllByRole("button")
        .find((b) => b.textContent?.startsWith(locales.secretStep.makeAgain))!,
    );
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenLastCalledWith("/steps/2/secret", {
        revision: 3,
        confirmRepeat: true,
      }),
    );
  });

  it("by hand: the reason, the format, engine, path and field, then Done", async () => {
    const client = await open();
    const body = card(4).querySelector('[data-secret-mode="by-hand"]')!;
    expect(body.querySelector("[data-by-hand-title]")!.textContent).toBe(
      locales.secretStep.byHand.title,
    );
    expect(body.querySelector("[data-by-hand-reason]")!.textContent).toBe(
      "Install and connect the OpenBao Secrets plugin to use secrets",
    );
    expect(body.textContent).toContain(
      "In a password manager, generate 64 hex digits (0-9, a-f).",
    );
    const place = body.querySelector("[data-by-hand-place]")!;
    expect(place.textContent).toContain("kv");
    expect(place.textContent).toContain("<app secrets folder>/web/host-1");
    expect(place.textContent).toContain("token");
    expect(place.querySelectorAll("[data-copy]")).toHaveLength(3);
    expect(card(4).querySelector("[data-make-secret]")).toBeNull();
    fireEvent.click(body.querySelector('[data-manual="done"]')!);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/steps/4/manual", {
        outcome: "done",
        note: "",
      }),
    );
  });

  it("a later step says where to get a secret kept by hand", async () => {
    await open();
    const hint = card(5).querySelector("[data-stdin-by-hand]")!;
    expect(hint.textContent).toContain(
      "Secret db_password is kept by hand now (step 2). Get it from OpenBao or Vault:",
    );
    expect(hint.textContent).toContain("runbooks/7");
  });

  it("a made secret's run says Made secret, with no command and no value", async () => {
    await open();
    const run = card(1).querySelector('[data-run="50"]')!;
    expect(run.textContent).toContain("Made secret old_pw by alice");
    expect(run.textContent).not.toContain("$ ");
    expect(card(1).querySelector("[data-secret-set]")!.textContent).toContain(
      "Secret old_pw is stored until",
    );
  });
});
