import { describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  card,
  fakeApi,
  locales,
  makeRun,
  makeRunbook,
  makeStep,
  openRunbook,
  useRenderedApp,
} from "./helpers";
import type { Runbook } from "../../src/frontend/api-types";

useRenderedApp();

const run = makeRun({
  command: "make-token",
  finishedAt: "2026-11-07T10:01:01.000Z",
  stdout: "token: [secret:api_token]\n",
  running: false,
  stdin: null,
  secrets: {
    used: [],
    captured: [{ name: "api_token", expiresAt: "2026-11-14T10:01:01.000Z" }],
  },
});

function runbook(overrides: Partial<Runbook> = {}) {
  return makeRunbook(
    [
      makeStep({
        id: 1,
        title: "Make token",
        status: "done",
        secretCaptures: [{ name: "api_token", pattern: "token: (\\S+)" }],
        runs: [run],
      }),
      makeStep({
        id: 2,
        title: "Make password",
        secretCaptures: [{ name: "db_password", pattern: "pw: (\\S+)" }],
      }),
    ],
    {
      title: "Tokens",
      nextStepId: 2,
      secretsAvailable: true,
      secrets: [
        {
          name: "api_token",
          step: 1,
          set: true,
          expiresAt: "2026-11-14T10:01:01.000Z",
        },
        { name: "db_password", step: 2, set: false, expiresAt: null },
      ],
      ...overrides,
    },
  );
}

const api = (data = runbook()) =>
  fakeApi({
    detail: data,
    post: async () => ({ data: { id: 40, status: "running" } }),
  });

const open = (client: ReturnType<typeof api>) =>
  openRunbook(client, { title: "Tokens", shows: "Make password" });

describe("secret captures in the UI", () => {
  it("says which secrets a step captures and whether each is stored", async () => {
    await open(api());
    const stored = card(1).querySelector('[data-secret="api_token"]')!;
    expect(stored.getAttribute("data-secret-set")).toBe("true");
    expect(stored.textContent).toMatch(
      /^Captures secret api_token · stored in OpenBao until /,
    );
    expect(
      card(2).querySelector('[data-secret="db_password"]')!.textContent,
    ).toBe("Captures secret db_password · not stored");
    expect(
      card(1).querySelector("[data-run-secrets-stored]")!.textContent,
    ).toBe("Stored secret: api_token");
  });

  it("says so in the Run confirm", async () => {
    await open(api());
    fireEvent.click(within(card(2)).getByText(locales.step.run));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.querySelector("[data-confirm-secrets]")!.textContent).toBe(
      "Captures secret db_password: kept in OpenBao for 7 days, never shown.",
    );
  });

  it("blocks Run and Send without the service, and says why", async () => {
    const data = runbook({ secretsAvailable: false });
    data.steps[1].secretsProblem =
      "Install and connect the OpenBao Secrets plugin to use secrets";
    await open(api(data));
    expect(card(2).querySelector("[data-secrets-problem]")!.textContent).toBe(
      "Install and connect the OpenBao Secrets plugin to use secrets",
    );
    for (const label of [locales.step.run, locales.step.send]) {
      expect(within(card(2)).getByText(label).closest("button")!.disabled).toBe(
        true,
      );
    }
  });

  it("says the output is held while such a run runs", async () => {
    const data = runbook();
    data.steps[1].runs = [
      {
        ...run,
        id: 22,
        stepId: 2,
        status: "running",
        running: true,
        stdout: "",
        outputHeld: true,
        secrets: null,
        elapsedMs: 1000,
        silentMs: 0,
      },
    ];
    await open(api(data));
    expect(card(2).querySelector("[data-output-held]")!.textContent).toBe(
      "The output shows when the run ends: this step captures a secret.",
    );
  });
});
