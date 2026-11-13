/**
 * Secret steps (1.4.2): Make a secret and Ask for a secret.
 *
 * A Make a secret step (`generate`) makes a new random value on the server
 * when a person clicks Make it. An Ask for a secret step (`ask`) takes a
 * value a person types or pastes once. Either way the value goes straight
 * to where the step's `store` says, through the OpenBao Secrets plugin, and
 * never to the browser, an agent, an event, the audit log or an output.
 *
 * Shared by the server (checks, views) and the UI (what a step says). No
 * React and no Node here.
 */

import {
  isOneLine,
  LIBRARY_REF,
  regexProblem,
  secretNameProblem,
} from "./names.js";

/** One part of an app path, "<app>/<host>", as OpenBao Secrets takes it. */
export const APP_PART = /^[A-Za-z0-9._-]{1,64}$/;
/** A field of an app secret. */
export const APP_FIELD = /^[A-Za-z0-9._-]{1,128}$/;

const MAX_ASK_LABEL = 200;
const MAX_ASK_PATTERN = 300;
/** OpenBao Secrets takes values up to 64 KiB. */
export const MAX_ASKED_BYTES = 64 * 1024;
/** A library secret Runbooks makes lives at most this many days. */
const MAX_LIBRARY_DAYS = 30;

export type SecretFormat = "alnum" | "hex" | "base64url" | "words" | "pin";

/** Each format's characters, bounds and default length. */
export const FORMATS: Record<
  SecretFormat,
  { min: number; max: number; default: number; alphabet: string | null }
> = {
  alnum: {
    min: 16,
    max: 128,
    default: 32,
    alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  },
  hex: { min: 16, max: 128, default: 64, alphabet: "0123456789abcdef" },
  base64url: {
    min: 16,
    max: 128,
    default: 43,
    alphabet:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  },
  // Words from the EFF long word list, joined by "-"; length counts words.
  words: { min: 4, max: 12, default: 6, alphabet: null },
  pin: { min: 4, max: 12, default: 6, alphabet: "0123456789" },
};

export const SECRET_FORMATS = Object.keys(FORMATS) as SecretFormat[];

/** Where a made or asked value goes. */
export type SecretStore =
  | { to: "runbook" }
  | { to: "library"; library: string; expires: number | null }
  | { to: "app"; app: string; host: string; field: string };

export interface GenerateSpec {
  name: string;
  format: SecretFormat;
  length: number;
  store: SecretStore;
}

export interface AskSpec {
  name: string;
  label: string;
  pattern: string | null;
  store: SecretStore;
}

/** A secret step as an author writes the store, and as views show it. */
export type AuthorStore =
  | "runbook"
  | { library: string; expires?: number }
  | { app: string; field: string };

function authorStore(store: SecretStore): AuthorStore {
  switch (store.to) {
    case "runbook":
      return "runbook";
    case "library":
      return store.expires
        ? { library: store.library, expires: store.expires }
        : { library: store.library };
    case "app":
      return { app: `${store.app}/${store.host}`, field: store.field };
  }
}

/** A Make a secret step's field, as an author writes it and views show it. */
export interface GenerateField {
  name: string;
  format: SecretFormat;
  length: number;
  store: AuthorStore;
}

/** An Ask for a secret step's field, as an author writes it. */
export interface AskField {
  name: string;
  label: string;
  pattern?: string;
  store: AuthorStore;
}

/** The step field as an author writes it and the API shows it. */
export function showGenerate(spec: GenerateSpec): GenerateField {
  return {
    name: spec.name,
    format: spec.format,
    length: spec.length,
    store: authorStore(spec.store),
  };
}

export function showAsk(spec: AskSpec): AskField {
  return {
    name: spec.name,
    label: spec.label,
    ...(spec.pattern !== null ? { pattern: spec.pattern } : {}),
    store: authorStore(spec.store),
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function nameOf(raw: unknown, field: string): string {
  const problem = secretNameProblem(raw, field);
  if (problem) fail(problem);
  return raw as string;
}

function onlyKeys(raw: Record<string, unknown>, keys: string[], at: string) {
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) fail(`${at} has an unknown field "${key}"`);
  }
}

function parseStore(raw: unknown, at: string): SecretStore {
  if (raw === undefined || raw === null || raw === "runbook") {
    return { to: "runbook" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail(
      `${at}.store must be "runbook", { library, expires? } or { app, field }`,
    );
  }
  const store = raw as Record<string, unknown>;
  if ("library" in store) {
    onlyKeys(store, ["library", "expires"], `${at}.store`);
    if (typeof store.library !== "string" || !LIBRARY_REF.test(store.library)) {
      fail(`${at}.store.library must be "mine/<name>" or "shared/<name>"`);
    }
    let expires: number | null = null;
    if (store.expires !== undefined && store.expires !== null) {
      if (
        !Number.isInteger(store.expires) ||
        (store.expires as number) < 1 ||
        (store.expires as number) > MAX_LIBRARY_DAYS
      ) {
        fail(
          `${at}.store.expires must be a number of days from 1 to ${MAX_LIBRARY_DAYS}`,
        );
      }
      expires = store.expires as number;
    }
    return { to: "library", library: store.library, expires };
  }
  if ("app" in store) {
    onlyKeys(store, ["app", "field"], `${at}.store`);
    const parts = typeof store.app === "string" ? store.app.split("/") : [];
    if (
      parts.length !== 2 ||
      !parts.every(
        (part) => APP_PART.test(part) && part !== "." && part !== "..",
      )
    ) {
      fail(
        `${at}.store.app must be "<app>/<host>", each 1 to 64 letters, digits, '.', '_' and '-'`,
      );
    }
    if (
      typeof store.field !== "string" ||
      !APP_FIELD.test(store.field) ||
      store.field === "." ||
      store.field === ".."
    ) {
      fail(
        `${at}.store.field must be 1 to 128 letters, digits, '.', '_' and '-'`,
      );
    }
    return { to: "app", app: parts[0], host: parts[1], field: store.field };
  }
  fail(
    `${at}.store must be "runbook", { library, expires? } or { app, field }`,
  );
}

/** A generate field as an author wrote it, checked. Throws a message. */
export function parseGenerate(raw: unknown): GenerateSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("generate must be an object { name, format?, length?, store? }");
  }
  const input = raw as Record<string, unknown>;
  onlyKeys(input, ["name", "format", "length", "store"], "generate");
  const name = nameOf(input.name, "generate.name");
  const format = (input.format ?? "alnum") as SecretFormat;
  if (!SECRET_FORMATS.includes(format)) {
    fail(`generate.format must be one of ${SECRET_FORMATS.join(", ")}`);
  }
  const bounds = FORMATS[format];
  const length = input.length ?? bounds.default;
  if (
    !Number.isInteger(length) ||
    (length as number) < bounds.min ||
    (length as number) > bounds.max
  ) {
    fail(
      `generate.length for ${format} must be an integer from ${bounds.min} to ${bounds.max}${
        format === "words" ? " (words)" : ""
      }`,
    );
  }
  return {
    name,
    format,
    length: length as number,
    store: parseStore(input.store, "generate"),
  };
}

/** An ask field as an author wrote it, checked. Throws a message. */
export function parseAsk(raw: unknown): AskSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("ask must be an object { name, label, pattern?, store? }");
  }
  const input = raw as Record<string, unknown>;
  onlyKeys(input, ["name", "label", "pattern", "store"], "ask");
  const name = nameOf(input.name, "ask.name");
  if (typeof input.label !== "string" || input.label.trim() === "") {
    fail("ask.label is required: what the person pastes, such as an API token");
  }
  const label = input.label.trim();
  if (label.length > MAX_ASK_LABEL) {
    fail(`ask.label is longer than ${MAX_ASK_LABEL} characters`);
  }
  if (!isOneLine(label)) fail("ask.label must be one line");
  let pattern: string | null = null;
  if (input.pattern !== undefined && input.pattern !== null) {
    const problem = regexProblem(
      input.pattern,
      "ask.pattern",
      MAX_ASK_PATTERN,
      "ask.pattern must be a regular expression as text",
    );
    if (problem) fail(problem);
    pattern = input.pattern as string;
  }
  return { name, label, pattern, store: parseStore(input.store, "ask") };
}

/** The kind of secret step, or null for any other step. */
export function secretStepKind(step: {
  generate?: unknown;
  ask?: unknown;
}): "generate" | "ask" | null {
  if (step.generate) return "generate";
  if (step.ask) return "ask";
  return null;
}

/** "32 letters and digits", in plain English, for audit lines and docs. */
export function describeFormat(format: SecretFormat, length: number): string {
  switch (format) {
    case "alnum":
      return `${length} letters and digits`;
    case "hex":
      return `${length} hex digits`;
    case "base64url":
      return `${length} base64url characters`;
    case "words":
      return `${length} words`;
    case "pin":
      return `${length} digits`;
  }
}

/** "the runbook's secrets", "library mine/db", "app web/host-1 field token". */
export function describeStore(store: SecretStore): string {
  switch (store.to) {
    case "runbook":
      return "the runbook's secrets";
    case "library":
      return `library ${store.library}`;
    case "app":
      return `app ${store.app}/${store.host} field ${store.field}`;
  }
}

/**
 * Where a person keeps the value by hand when OpenBao Secrets is not there
 * or cannot take it: a KV engine, a path and a field, in OpenBao or Vault.
 * OpenBao Secrets keeps its library under the KV mount "kv" and the folder
 * "termix" by default; an app path sits in the app secrets folder an admin
 * sets in OpenBao Secrets.
 */
export interface ByHand {
  engine: string;
  path: string;
  field: string;
}

export function byHandPlace(
  store: SecretStore,
  name: string,
  runbookId: number,
  userId?: string | null,
): ByHand {
  switch (store.to) {
    case "runbook":
      return { engine: "kv", path: `runbooks/${runbookId}`, field: name };
    case "library": {
      const match = LIBRARY_REF.exec(store.library);
      const rest = match ? match[2] : store.library;
      return {
        engine: "kv",
        path:
          match?.[1] === "shared"
            ? `termix/shared/${rest}`
            : `termix/users/${userId || "<your user id>"}/${rest}`,
        field: "value",
      };
    }
    case "app":
      return {
        engine: "kv",
        path: `<app secrets folder>/${store.app}/${store.host}`,
        field: store.field,
      };
  }
}
