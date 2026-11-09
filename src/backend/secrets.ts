/**
 * Secrets through the OpenBao Secrets plugin's service, openbao-secrets.store
 * (an optional requirement in the manifest). Runbooks keeps no secret value
 * of its own: no table column, no fallback store, nothing for the browser or
 * for agents. Without the service, steps that use secrets are refused.
 *
 * Every call runs as the person who acts (core checks their Use secrets
 * permission first). Runbooks' own area needs its area key, which the
 * service hands to the receiver this plugin provides in ctx.registry
 * (docs/service.md of OpenBao Secrets). The key stays in memory, and the
 * receiver takes one only while this plugin's own bindPlugin call runs.
 */

import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { InputError } from "./service.js";

export const SECRETS_SERVICE = "openbao-secrets.store";
export const NO_SECRETS =
  "Install and connect the OpenBao Secrets plugin to use secrets";
/** How long a captured secret lives in OpenBao. */
export const SECRET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Area = "user" | "shared" | { plugin: string; key: string };

/** The part of the service's contract Runbooks uses. */
export interface SecretsStore {
  status(): Promise<{ connected: boolean; backend: string }>;
  bindPlugin(pluginId: string): Promise<void>;
  put(
    area: Area,
    name: string,
    value: string,
    options?: { expiresAt?: string | null; note?: string | null },
  ): Promise<void>;
  get(area: Area, name: string): Promise<string | null>;
  remove(area: Area, name: string): Promise<boolean>;
  removePrefix(area: Area, prefix: string): Promise<number>;
}

const AREA_KEY = /^[0-9a-f]{64}$/;

/** Where a runbook's captured secrets live in Runbooks' area. */
export const runbookPrefix = (runbookId: number) => `runbooks/${runbookId}/`;
export const runbookSecretName = (runbookId: number, name: string) =>
  `${runbookPrefix(runbookId)}${name}`;

export type Secrets = ReturnType<typeof createSecrets>;

export function createSecrets(ctx: PluginContext) {
  const pluginId = ctx.manifest.id;
  let key: string | null = null;
  let binding = false;
  let bound: Promise<void> | null = null;

  ctx.registry.provide(`${pluginId}.secretsStoreKey`, (given: unknown) => {
    // Anyone may call this; only a key given during our own bind counts.
    if (!binding) throw new Error("Runbooks is not binding");
    if (typeof given !== "string" || !AREA_KEY.test(given)) {
      throw new Error("not an area key");
    }
    key = given;
  });

  /** The service, or null when no plugin provides it now. */
  function handle(): SecretsStore | null {
    const store = ctx.services.get<SecretsStore>(SECRETS_SERVICE);
    return "put" in store ? store : null;
  }

  /** The service's error as a refusal. Its messages never hold a value. */
  function refusal(error: unknown): InputError {
    if (error instanceof InputError) return error;
    const code = (error as { code?: unknown })?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "EPLUGINSVCGONE") {
      return new InputError(NO_SECRETS, 409, { code: "no-secrets" });
    }
    if (code === "EPLUGINSVCPERM" || /permission/i.test(message)) {
      return new InputError(
        "you need the Use secrets permission of OpenBao Secrets to run steps that use secrets",
        403,
        { code: "secrets-permission" },
      );
    }
    return new InputError(`OpenBao Secrets: ${message}`, 409, {
      code: "secrets-error",
    });
  }

  /** The service, connected to OpenBao, or a refusal. */
  async function connected(): Promise<SecretsStore> {
    const store = handle();
    if (!store) throw new InputError(NO_SECRETS, 409, { code: "no-secrets" });
    let status: { connected: boolean };
    try {
      status = await store.status();
    } catch (error) {
      throw refusal(error);
    }
    if (!status.connected) {
      throw new InputError(NO_SECRETS, 409, { code: "no-secrets" });
    }
    return store;
  }

  async function bind(store: SecretsStore): Promise<void> {
    if (!bound) {
      bound = (async () => {
        binding = true;
        try {
          await store.bindPlugin(pluginId);
        } finally {
          binding = false;
        }
        if (!key) throw new Error("OpenBao Secrets gave no area key");
      })().finally(() => {
        bound = null;
      });
    }
    await bound;
  }

  /** Runs `fn` with Runbooks' area, binding again once if the key is refused. */
  async function inArea<T>(
    fn: (store: SecretsStore, area: Area) => Promise<T>,
  ): Promise<T> {
    const store = await connected();
    try {
      if (!key) await bind(store);
      try {
        return await fn(store, { plugin: pluginId, key: key! });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!/area key/i.test(message)) throw error;
        key = null;
        await bind(store);
        return await fn(store, { plugin: pluginId, key: key! });
      }
    } catch (error) {
      throw refusal(error);
    }
  }

  return {
    /** Whether a plugin provides the service now (no call, no audit). */
    available: () => handle() !== null,

    /** Refuses unless the service is there and connected. */
    async require(): Promise<void> {
      await connected();
    },

    /** A secret this runbook captured, or null. */
    getCaptured(runbookId: number, name: string): Promise<string | null> {
      return inArea((store, area) =>
        store.get(area, runbookSecretName(runbookId, name)),
      );
    },

    /** A secret from the person's library: their own or a shared one. */
    async getLibrary(
      area: "user" | "shared",
      name: string,
    ): Promise<string | null> {
      const store = await connected();
      try {
        return await store.get(area, name);
      } catch (error) {
        throw refusal(error);
      }
    },

    putCaptured(
      runbookId: number,
      name: string,
      value: string,
      expiresAt: string,
    ): Promise<void> {
      return inArea((store, area) =>
        store.put(area, runbookSecretName(runbookId, name), value, {
          expiresAt,
        }),
      );
    },

    removeCaptured(runbookId: number, name: string): Promise<boolean> {
      return inArea((store, area) =>
        store.remove(area, runbookSecretName(runbookId, name)),
      );
    },

    /** Deletes every secret the runbook captured. */
    removeRunbook(runbookId: number): Promise<number> {
      return inArea((store, area) =>
        store.removePrefix(area, runbookPrefix(runbookId)),
      );
    },
  };
}
