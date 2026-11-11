import { afterEach, describe, expect, it } from "vitest";
import {
  agentRunbook,
  auditText,
  everything,
  runStep,
  startServer,
  view,
  type TestServer,
} from "./helpers";
import {
  FORMATS,
  SECRET_FORMATS,
  type SecretFormat,
} from "../../src/shared/secret-steps";
import { generateSecret, passphrase, pick } from "../../src/backend/generate";
import { WORDS } from "../../src/backend/wordlist";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const DAY = 24 * 60 * 60 * 1000;

const makeStep = (generate: Record<string, unknown> = {}) => ({
  title: "Make the database password",
  generate: { name: "db_password", ...generate },
});
const askStep = (ask: Record<string, unknown> = {}) => ({
  title: "Paste the API token",
  ask: { name: "api_token", label: "API token", ...ask },
});
const reader = (name: string) => ({
  title: `Use ${name}`,
  hostId: 1,
  command: "login --password-stdin",
  stdin: { from: "secret", name },
});

async function setup(
  steps: Array<Record<string, unknown>>,
  options: { secrets?: boolean } = { secrets: true },
) {
  server = await startServer({ secrets: options.secrets });
  const token = await server.makeToken();
  const runbook = await agentRunbook(server, token, {
    title: "Secrets",
    steps,
  });
  return { s: server, token, runbook };
}

/** Make it or Save, as the page does, with what the view showed. */
async function secret(
  s: TestServer,
  runbookId: number,
  stepId: number,
  extra: Record<string, unknown> = {},
  user = "alice",
) {
  const shown = await view(s, runbookId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const step = shown.steps.find((x: any) => x.id === stepId);
  return s.person(
    "POST",
    `/steps/${stepId}/secret`,
    { revision: step.revision, ...extra },
    { user },
  );
}

const stored = (s: TestServer, runbookId: number, name: string) =>
  s.secrets!.data.get(`plugin:runbooks|runbooks/${runbookId}/${name}`);

/** Everything a value must never be in. */
async function everywhere(s: TestServer, runbookId: number) {
  const token = await s.makeToken("reader");
  const agentView = await s.agent("GET", `/runbooks/${runbookId}`, token);
  const events = await s.agent("GET", `/events`, token);
  const mcp = await s.agent("POST", "/mcp", token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_runbook", arguments: { runbookId } },
  });
  return [
    everything(s),
    JSON.stringify(await view(s, runbookId)),
    JSON.stringify(await s.person("GET", "/runbooks")),
    JSON.stringify(agentView.body),
    JSON.stringify(events.body),
    JSON.stringify(mcp.body),
    auditText(s),
  ].join("\n");
}

describe("the step fields", () => {
  it("take generate with defaults, and ask with a label", async () => {
    const { runbook } = await setup([
      makeStep(),
      askStep({ pattern: "[a-z]{8}", store: { library: "mine/tokens/x" } }),
    ]);
    expect(runbook.steps[0].generate).toEqual({
      name: "db_password",
      format: "alnum",
      length: 32,
      store: "runbook",
    });
    expect(runbook.steps[1].ask).toEqual({
      name: "api_token",
      label: "API token",
      pattern: "[a-z]{8}",
      store: { library: "mine/tokens/x" },
    });
  });

  it("have each format's length bounds and default", async () => {
    server = await startServer({ secrets: true });
    const token = await server.makeToken();
    const make = (generate: Record<string, unknown>) =>
      server!.agent("POST", "/runbooks", token, {
        title: "x",
        steps: [{ title: "Make", generate: { name: "x", ...generate } }],
      });
    for (const format of SECRET_FORMATS) {
      const { min, max } = FORMATS[format];
      for (const length of [min, max]) {
        const ok = await make({ format, length });
        expect(ok.status, `${format} ${length}`).toBe(201);
        expect(ok.body.steps[0].generate.length).toBe(length);
      }
      for (const length of [min - 1, max + 1, 1.5, "32"]) {
        const bad = await make({ format, length });
        expect(bad.status, `${format} ${length}`).toBe(400);
        expect(bad.body.error).toContain(
          `generate.length for ${format} must be an integer from ${min} to ${max}`,
        );
      }
      const fallback = await make({ format });
      expect(fallback.body.steps[0].generate.length).toBe(
        FORMATS[format].default,
      );
    }
    expect(FORMATS.alnum).toMatchObject({ min: 16, max: 128, default: 32 });
  });

  it("refuse a bad format, name, label, pattern or store with 400", async () => {
    server = await startServer({ secrets: true });
    const token = await server.makeToken();
    const error = async (step: Record<string, unknown>) => {
      const made = await server!.agent("POST", "/runbooks", token, {
        title: "x",
        steps: [{ title: "Step", ...step }],
      });
      expect(made.status).toBe(400);
      return made.body.error as string;
    };
    expect(await error(makeStep({ format: "emoji" }))).toContain(
      "generate.format must be one of alnum, hex, base64url, words, pin",
    );
    expect(await error({ generate: { name: "1bad" } })).toContain(
      "generate.name must match",
    );
    expect(await error({ generate: { name: "a".repeat(65) } })).toContain(
      "longer than 64",
    );
    expect(await error({ generate: { name: "x", extra: 1 } })).toContain(
      'generate has an unknown field "extra"',
    );
    expect(await error({ ask: { name: "x" } })).toContain(
      "ask.label is required",
    );
    expect(await error({ ask: { name: "x", label: "a\nb" } })).toContain(
      "ask.label must be one line",
    );
    expect(await error(askStep({ pattern: "([" }))).toContain(
      "ask.pattern is not a valid regular expression",
    );
    expect(await error(askStep({ pattern: "a".repeat(301) }))).toContain(
      "ask.pattern is longer than 300",
    );
    for (const store of [
      "elsewhere",
      { library: "ours/x" },
      { library: "mine/x", expires: 31 },
      { library: "mine/x", expires: 0 },
      { app: "web", field: "token" },
      { app: "web/host-1/extra", field: "token" },
      { app: "web/host-1", field: "a b" },
      { app: "web/host-1" },
      { app: "web/..", field: "token" },
      { library: "mine/x", app: "web/host-1" },
    ]) {
      expect(await error(makeStep({ store })), JSON.stringify(store)).toMatch(
        /generate\.store/,
      );
    }
  });

  it("refuse an agent's step, a command, a host and the other run fields", async () => {
    server = await startServer({ secrets: true });
    const token = await server.makeToken();
    const error = async (step: Record<string, unknown>) => {
      const made = await server!.agent("POST", "/runbooks", token, {
        title: "x",
        steps: [step],
      });
      expect(made.status).toBe(400);
      return made.body.error as string;
    };
    expect(await error({ ...makeStep(), owner: "agent" })).toContain(
      "is for a person: an agent can never make, see or save a secret",
    );
    expect(await error({ ...askStep(), ...makeStep() })).toContain(
      "either generate or ask, not both",
    );
    for (const extra of [
      { hostId: 1, command: "x" },
      { where: "PC", command: "x" },
      { checks: [{ type: "contains", text: "x" }] },
      { captures: [{ name: "x", pattern: "(x)" }] },
    ]) {
      expect(await error({ ...makeStep(), ...extra })).toContain(
        "a Make a secret step cannot have",
      );
    }
  });

  it("let a later step read a runbook secret by name, and point library and app readers elsewhere", async () => {
    server = await startServer({ secrets: true });
    const token = await server.makeToken();
    const ok = await server.agent("POST", "/runbooks", token, {
      title: "x",
      steps: [
        makeStep(),
        askStep(),
        reader("db_password"),
        reader("api_token"),
      ],
    });
    expect(ok.status).toBe(201);
    const library = await server.agent("POST", "/runbooks", token, {
      title: "x",
      steps: [
        makeStep({ store: { library: "mine/db" } }),
        reader("db_password"),
      ],
    });
    expect(library.status).toBe(400);
    expect(library.body.error).toContain(
      'which step 1 keeps in the library: read it with {"from":"secret","library":"mine/db"}',
    );
    const app = await server.agent("POST", "/runbooks", token, {
      title: "x",
      steps: [
        makeStep({ store: { app: "web/host-1", field: "token" } }),
        reader("db_password"),
      ],
    });
    expect(app.status).toBe(400);
    expect(app.body.error).toContain("Runbooks cannot read it back");
  });
});

describe("making values", () => {
  const ALPHABET_RE: Record<Exclude<SecretFormat, "words">, RegExp> = {
    alnum: /^[A-Za-z0-9]+$/,
    hex: /^[0-9a-f]+$/,
    base64url: /^[A-Za-z0-9_-]+$/,
    pin: /^[0-9]+$/,
  };

  it("gives each format its characters and length", () => {
    for (const format of ["alnum", "hex", "base64url", "pin"] as const) {
      for (const length of [FORMATS[format].min, FORMATS[format].max]) {
        const value = generateSecret(format, length);
        expect(value).toHaveLength(length);
        expect(value).toMatch(ALPHABET_RE[format]);
      }
    }
    const words = generateSecret("words", 6).split("-");
    // Four words of the list hold a "-" themselves (t-shirt, yo-yo).
    expect(words.length).toBeGreaterThanOrEqual(6);
    expect(WORDS).toHaveLength(7776);
    expect(new Set(WORDS).size).toBe(7776);
    const phrase = passphrase(6, ["alpha", "beta"]);
    expect(phrase.split("-")).toHaveLength(6);
    expect(phrase.split("-").every((w) => w === "alpha" || w === "beta")).toBe(
      true,
    );
    expect(() => generateSecret("alnum", 15)).toThrow();
    expect(() => generateSecret("words", 13)).toThrow();
  });

  /**
   * Chi-square of character counts against a uniform spread. crypto has no
   * seed, so the bound is loose: the 99.9999th percentile of chi-square is
   * near df + 7 * sqrt(2 df), far below what a modulo bias gives (a byte %
   * 62 makes 8 characters 25% likelier: a statistic of several hundred).
   */
  function chiSquare(alphabet: string, text: string): number {
    const counts = new Map<string, number>();
    for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
    const expected = text.length / alphabet.length;
    let sum = 0;
    for (const char of alphabet) {
      const seen = counts.get(char) ?? 0;
      sum += (seen - expected) ** 2 / expected;
    }
    return sum;
  }

  for (const format of ["alnum", "hex", "base64url", "pin"] as const) {
    it(`uses the ${format} alphabet evenly (chi-square)`, () => {
      const alphabet = FORMATS[format].alphabet!;
      let text = "";
      // About 1000 of each character.
      const per = FORMATS[format].max;
      const values = Math.ceil((alphabet.length * 1000) / per);
      for (let i = 0; i < values; i++) text += generateSecret(format, per);
      const df = alphabet.length - 1;
      const bound = df + 7 * Math.sqrt(2 * df);
      expect(chiSquare(alphabet, text)).toBeLessThan(bound);
      // Every character turns up.
      expect(new Set(text).size).toBe(alphabet.length);
    });
  }

  it("would catch a modulo bias", () => {
    const alphabet = FORMATS.alnum.alphabet!;
    let text = "";
    // What a byte % 62 makes: the first 8 characters 25% likelier.
    for (let i = 0; i < 62_000; i++) {
      const byte = Math.floor(Math.random() * 256);
      text += alphabet[byte % 62];
    }
    const df = alphabet.length - 1;
    expect(chiSquare(alphabet, text)).toBeGreaterThan(
      df + 7 * Math.sqrt(2 * df),
    );
  });

  it("picks words evenly too", () => {
    // The same picker over 16 stand-in words.
    const words = Array.from({ length: 16 }, (_, i) => `w${i}`);
    const picked = passphrase(16_000, words).split("-");
    const counts = new Map<string, number>();
    for (const word of picked) counts.set(word, (counts.get(word) ?? 0) + 1);
    let sum = 0;
    for (const word of words)
      sum += ((counts.get(word) ?? 0) - 1000) ** 2 / 1000;
    expect(sum).toBeLessThan(15 + 7 * Math.sqrt(30));
    expect(pick("ab", 4)).toMatch(/^[ab]{4}$/);
  });
});

describe("Make a secret", () => {
  it("makes the value on the server, stores it for 7 days, and a later step reads it", async () => {
    const { s, runbook } = await setup([
      makeStep({ format: "hex", length: 40 }),
      reader("db_password"),
      { title: "Show config", hostId: 1, command: "cat config" },
    ]);
    const made = await secret(s, runbook.id, runbook.steps[0].id);
    expect(made.status).toBe(200);
    const value = stored(s, runbook.id, "db_password")!;
    expect(value.value).toMatch(/^[0-9a-f]{40}$/);
    expect(
      Math.abs(Date.parse(value.expiresAt!) - (Date.now() + 7 * DAY)),
    ).toBeLessThan(60_000);

    const step = made.body.steps[0];
    expect(step.status).toBe("done");
    expect(step.secretStep).toMatchObject({
      kind: "generate",
      name: "db_password",
      mode: "ready",
      set: true,
      expiresAt: value.expiresAt,
    });
    const run = step.runs[0];
    expect(run).toMatchObject({
      mode: "secret",
      status: "done",
      command: "",
      hostId: null,
      userId: "alice",
    });
    expect(run.secrets).toEqual({
      used: [],
      captured: [{ name: "db_password", expiresAt: value.expiresAt }],
      made: {
        name: "db_password",
        how: "made",
        store: "runbook",
        where: null,
        expiresAt: value.expiresAt,
      },
    });
    expect(made.body.secrets).toEqual([
      {
        name: "db_password",
        step: 1,
        set: true,
        expiresAt: value.expiresAt,
      },
    ]);
    expect(
      s.mock.audits.find((a) => a.action === "runbooks_step_secret")!.details,
    ).toBe(
      `runbook ${runbook.id} step 1 made secret db_password (40 hex digits) in the runbook's secrets`,
    );

    // A later step gets it on standard input; its output hides it.
    s.setExec(async () => ({
      stdout: `logged in with ${value.value}\n`,
      stderr: "",
      code: 0,
      truncated: false,
      timedOut: false,
    }));
    const used = await runStep(s, runbook.id, runbook.steps[1].id);
    expect(used.body.status).toBe("done");
    expect(s.channels[0].stdin).toBe(`${value.value}\n`);
    expect(used.body.stdout).toBe("logged in with [secret:db_password]\n");
    // Every later output hides it, also of a step that does not read it.
    s.setExec(async () => ({
      stdout: `password=${value.value}\n`,
      stderr: `warn ${value.value}`,
      code: 0,
      truncated: false,
      timedOut: false,
    }));
    const other = await runStep(s, runbook.id, runbook.steps[2].id);
    expect(other.body.stdout).toBe("password=[secret:db_password]\n");
    expect(other.body.stderr).toBe("warn [secret:db_password]");
    expect(other.body.secrets).toBeNull();

    expect(await everywhere(s, runbook.id)).not.toContain(value.value);
  });

  it("asks about a repeat, the order and a stale view", async () => {
    const { s, runbook } = await setup([
      { title: "First" },
      makeStep({ format: "pin", length: 8 }),
    ]);
    const stepId = runbook.steps[1].id;
    const stale = await s.person("POST", `/steps/${stepId}/secret`, {
      revision: 99,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stale");

    const order = await secret(s, runbook.id, stepId);
    expect(order.status).toBe(409);
    expect(order.body.code).toBe("order");
    expect(stored(s, runbook.id, "db_password")).toBeUndefined();

    expect(
      (await secret(s, runbook.id, stepId, { outOfOrder: true })).status,
    ).toBe(200);
    const first = stored(s, runbook.id, "db_password")!.value;
    expect(first).toMatch(/^[0-9]{8}$/);

    const repeat = await secret(s, runbook.id, stepId, { outOfOrder: true });
    expect(repeat.status).toBe(409);
    expect(repeat.body.code).toBe("repeat");
    expect(repeat.body.error).toBe("step 2 made secret db_password already");
    const again = await secret(s, runbook.id, stepId, {
      outOfOrder: true,
      confirmRepeat: true,
    });
    expect(again.status).toBe(200);
    expect(again.body.steps[1].runs).toHaveLength(2);
    // A new value (8 random digits: the same twice is 1 in 10^8).
    expect(stored(s, runbook.id, "db_password")!.value).not.toBe(first);
  });

  it("is a person's click only: refused for an API key, an agent and without a login", async () => {
    const { s, token, runbook } = await setup([makeStep()]);
    const stepId = runbook.steps[0].id;
    const shown = await view(s, runbook.id);
    const key = await s.person(
      "POST",
      `/steps/${stepId}/secret`,
      { revision: shown.steps[0].revision },
      { apiKey: true },
    );
    expect(key.status).toBe(403);
    const anon = await s.raw("POST", `/steps/${stepId}/secret`, {}, {});
    expect(anon.status).toBe(401);
    const complete = await s.agent("POST", `/steps/${stepId}/complete`, token, {
      outcome: "done",
    });
    expect(complete.status).toBe(403);
    expect(complete.body.code).toBe("person-step");
    const agentRoute = await s.agent("POST", `/steps/${stepId}/secret`, token, {
      revision: 1,
    });
    expect(agentRoute.status).toBe(404);
    expect(stored(s, runbook.id, "db_password")).toBeUndefined();
    expect(s.secrets!.calls.filter((c) => c.method === "put")).toEqual([]);
  });

  it("refuses a step that makes no secret", async () => {
    const { s, runbook } = await setup([{ title: "Plain" }]);
    const reply = await secret(s, runbook.id, runbook.steps[0].id);
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe("not-secret-step");
  });

  it("deletes a runbook secret it made when the runbook is done", async () => {
    const { s, runbook } = await setup([makeStep()]);
    await secret(s, runbook.id, runbook.steps[0].id);
    expect(stored(s, runbook.id, "db_password")).toBeDefined();
    await s.person("POST", `/runbooks/${runbook.id}/status`, {
      status: "done",
    });
    expect(stored(s, runbook.id, "db_password")).toBeUndefined();
  });
});

describe("Ask for a secret", () => {
  it("checks the pattern against the whole value, trimmed, and never says the value", async () => {
    const { s, runbook } = await setup([
      askStep({ pattern: "cf_[A-Za-z0-9]{12}" }),
      reader("api_token"),
    ]);
    const stepId = runbook.steps[0].id;
    const empty = await secret(s, runbook.id, stepId, { value: "   " });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("empty");
    const wrong = "xx_cf_abcdefghijkl";
    const bad = await secret(s, runbook.id, stepId, { value: wrong });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("pattern");
    expect(JSON.stringify(bad.body)).not.toContain(wrong);
    const missing = await secret(s, runbook.id, stepId, {});
    expect(missing.status).toBe(400);

    const value = "cf_Ab12Cd34Ef56";
    const saved = await secret(s, runbook.id, stepId, {
      value: `  ${value}\n`,
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(value);
    expect(stored(s, runbook.id, "api_token")!.value).toBe(value);
    expect(saved.body.steps[0].runs[0].secrets.made).toMatchObject({
      name: "api_token",
      how: "saved",
      store: "runbook",
    });
    expect(
      s.mock.audits.find((a) => a.action === "runbooks_step_secret")!.details,
    ).toBe(
      `runbook ${runbook.id} step 1 saved secret api_token in the runbook's secrets`,
    );

    s.setExec(async () => ({
      stdout: `token ${value} ok`,
      stderr: "",
      code: 0,
      truncated: false,
      timedOut: false,
    }));
    const used = await runStep(s, runbook.id, runbook.steps[1].id);
    expect(s.channels[0].stdin).toBe(`${value}\n`);
    expect(used.body.stdout).toBe("token [secret:api_token] ok");
    const text = await everywhere(s, runbook.id);
    expect(text).not.toContain(value);
    expect(text).not.toContain(wrong);
  });

  it("stops a pattern that does not finish", async () => {
    const { s, runbook } = await setup([askStep({ pattern: "(a+)+b" })]);
    const reply = await secret(s, runbook.id, runbook.steps[0].id, {
      value: `${"a".repeat(40)}c`,
    });
    expect(reply.status).toBe(400);
    expect(reply.body.error).toContain("did not finish");
  });
});

describe("where the value goes", () => {
  it("library: a new secret in the person's own area, with its expiry, never replacing one", async () => {
    const { s, runbook } = await setup([
      makeStep({
        format: "words",
        length: 5,
        store: { library: "mine/db/pw", expires: 3 },
      }),
      askStep({ store: { library: "mine/db/pw" } }),
    ]);
    const made = await secret(s, runbook.id, runbook.steps[0].id);
    expect(made.status).toBe(200);
    const entry = s.secrets!.data.get("user:alice|db/pw")!;
    expect(entry.value.split("-").length).toBeGreaterThanOrEqual(5);
    expect(
      Math.abs(Date.parse(entry.expiresAt!) - (Date.now() + 3 * DAY)),
    ).toBeLessThan(60_000);
    expect(made.body.steps[0].runs[0].secrets.made).toEqual({
      name: "db_password",
      how: "made",
      store: "library",
      where: "mine/db/pw",
      expiresAt: entry.expiresAt,
    });
    // Not one of the runbook's own secrets.
    expect(made.body.secrets).toEqual([]);

    const taken = await secret(s, runbook.id, runbook.steps[1].id, {
      value: "something",
    });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("exists");
    expect(s.secrets!.data.get("user:alice|db/pw")!.value).toBe(entry.value);
    expect(await everywhere(s, runbook.id)).not.toContain(entry.value);
  });

  it("library: a later step reads it with the library form", async () => {
    const { s, runbook } = await setup([
      makeStep({ store: { library: "shared/ci/pw" } }),
      {
        title: "Use it",
        hostId: 1,
        command: "login --password-stdin",
        stdin: { from: "secret", library: "shared/ci/pw" },
      },
    ]);
    await secret(s, runbook.id, runbook.steps[0].id);
    const value = s.secrets!.data.get("shared|ci/pw")!.value;
    await runStep(s, runbook.id, runbook.steps[1].id);
    expect(s.channels[0].stdin).toBe(`${value}\n`);
  });

  it("app: a new field through createAppField", async () => {
    const { s, runbook } = await setup([
      makeStep({ store: { app: "web/host-1", field: "token" } }),
    ]);
    const made = await secret(s, runbook.id, runbook.steps[0].id);
    expect(made.status).toBe(200);
    const value = s.secrets!.apps.get("web/host-1")!.token;
    expect(value).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(s.secrets!.calls.at(-1)).toEqual({
      method: "createAppField",
      area: "plugin:runbooks",
      name: "web/host-1#token",
    });
    expect(made.body.steps[0].runs[0].secrets.made).toMatchObject({
      store: "app",
      where: "web/host-1#token",
    });
    expect(
      s.mock.audits.find((a) => a.action === "runbooks_step_secret")!.details,
    ).toContain("in app web/host-1 field token");
    expect(await everywhere(s, runbook.id)).not.toContain(value);
  });

  it("app: says why the store refused, and never replaces a field", async () => {
    const { s, runbook } = await setup([
      makeStep({ store: { app: "web/host-1", field: "token" } }),
      makeStep({ name: "other", store: { app: "db/host-2", field: "pw" } }),
    ]);
    const [first, second] = runbook.steps;
    s.secrets!.apps.set("web/host-1", { token: "old" });
    const exists = await secret(s, runbook.id, first.id);
    expect(exists.status).toBe(409);
    expect(exists.body.code).toBe("exists");
    expect(s.secrets!.apps.get("web/host-1")!.token).toBe("old");

    const notAllowed = await secret(s, runbook.id, second.id, {
      outOfOrder: true,
    });
    expect(notAllowed.status).toBe(409);
    expect(notAllowed.body.code).toBe("app-not-allowed");

    s.secrets!.appsAllowed = null;
    const off = await secret(s, runbook.id, second.id, { outOfOrder: true });
    expect(off.status).toBe(409);
    expect(off.body.code).toBe("app-store-off");

    s.secrets!.appsAllowed = new Set(["db/host-2"]);
    s.secrets!.appCreators.clear();
    const perm = await secret(s, runbook.id, second.id, { outOfOrder: true });
    expect(perm.status).toBe(403);
    expect(perm.body.code).toBe("secrets-permission");
  });

  it("app: an older OpenBao Secrets without createAppField shows the steps by hand", async () => {
    const { s, runbook } = await setup([
      makeStep({ store: { app: "web/host-1", field: "token" } }),
    ]);
    delete (s.secrets as unknown as Record<string, unknown>).createAppField;
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].secretStep).toEqual({
      kind: "generate",
      name: "db_password",
      mode: "by-hand",
      reason:
        "Saving to an app path needs OpenBao Secrets 1.0.5 or later, with the allowed app paths an admin sets there",
      byHand: {
        engine: "kv",
        path: "<app secrets folder>/web/host-1",
        field: "token",
      },
      set: false,
      expiresAt: null,
    });
    const refused = await secret(s, runbook.id, runbook.steps[0].id);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("app-store-unsupported");
    // Done by hand instead.
    const done = await s.person(
      "POST",
      `/steps/${runbook.steps[0].id}/manual`,
      {
        outcome: "done",
      },
    );
    expect(done.status).toBe(200);
    expect(done.body.steps[0].status).toBe("done");
  });
});

describe("without OpenBao Secrets", () => {
  it("shows the steps by hand, and a later step says where to get the secret", async () => {
    const { s, runbook } = await setup(
      [
        makeStep(),
        askStep({ store: { library: "mine/cf" } }),
        reader("db_password"),
      ],
      { secrets: false },
    );
    const shown = await view(s, runbook.id);
    expect(shown.steps[0].secretStep).toMatchObject({
      kind: "generate",
      mode: "by-hand",
      reason: "Install and connect the OpenBao Secrets plugin to use secrets",
      byHand: {
        engine: "kv",
        path: `runbooks/${runbook.id}`,
        field: "db_password",
      },
    });
    expect(shown.steps[1].secretStep.byHand).toEqual({
      engine: "kv",
      path: "termix/users/alice/cf",
      field: "value",
    });
    expect(shown.steps[2].stdin.byHand).toEqual({
      engine: "kv",
      path: `runbooks/${runbook.id}`,
      field: "db_password",
      step: "1",
    });

    const refused = await secret(s, runbook.id, runbook.steps[0].id);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("no-secrets");
    const done = await s.person(
      "POST",
      `/steps/${runbook.steps[0].id}/manual`,
      {
        outcome: "done",
        note: "made in the password manager",
      },
    );
    expect(done.status).toBe(200);
    expect(done.body.steps[0].runs[0].mode).toBe("manual");
  });

  it("does the same while OpenBao Secrets is not connected", async () => {
    server = await startServer({ secrets: true });
    server.secrets!.connected = false;
    const token = await server.makeToken();
    const runbook = await agentRunbook(server, token, {
      title: "x",
      steps: [makeStep(), reader("db_password")],
    });
    const shown = await view(server, runbook.id);
    expect(shown.steps[0].secretStep.mode).toBe("by-hand");
    expect(shown.steps[1].stdin.byHand.step).toBe("1");
    const refused = await secret(server, runbook.id, runbook.steps[0].id);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("no-secrets");

    // Connected again: Make it works and the view is ready.
    server.secrets!.connected = true;
    const again = await view(server, runbook.id);
    expect(again.steps[0].secretStep.mode).toBe("ready");
    expect(again.steps[1].stdin.byHand).toBeUndefined();
  });
});

describe("agents", () => {
  it("see the field and the run's names, never a value, over REST and MCP", async () => {
    const { s, token, runbook } = await setup([
      makeStep({ format: "base64url" }),
    ]);
    await secret(s, runbook.id, runbook.steps[0].id);
    const agentView = await s.agent("GET", `/runbooks/${runbook.id}`, token);
    expect(agentView.body.steps[0].generate).toEqual({
      name: "db_password",
      format: "base64url",
      length: 43,
      store: "runbook",
    });
    expect(agentView.body.steps[0].runs[0].secrets.made.name).toBe(
      "db_password",
    );
    const value = stored(s, runbook.id, "db_password")!.value;
    expect(JSON.stringify(agentView.body)).not.toContain(value);
    const tools = await s.agent("POST", "/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const create = tools.body.result.tools.find(
      (tool: { name: string }) => tool.name === "create_runbook",
    );
    expect(create.description).toContain("Make a secret and Ask for a secret");
  });

  it("can change a pending step into a secret step and back", async () => {
    const { s, token, runbook } = await setup([{ title: "Plain" }]);
    const stepId = runbook.steps[0].id;
    const made = await s.agent("PATCH", `/steps/${stepId}`, token, {
      generate: { name: "x" },
    });
    expect(made.status).toBe(200);
    expect(made.body.steps[0].generate.name).toBe("x");
    const bad = await s.agent("PATCH", `/steps/${stepId}`, token, {
      hostId: 1,
      command: "x",
    });
    expect(bad.status).toBe(400);
    const back = await s.agent("PATCH", `/steps/${stepId}`, token, {
      generate: null,
      hostId: 1,
      command: "x",
    });
    expect(back.status).toBe(200);
    expect(back.body.steps[0].generate).toBeNull();
  });
});
