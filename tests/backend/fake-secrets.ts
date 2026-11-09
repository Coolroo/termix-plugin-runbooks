import { createHash } from "node:crypto";
import type { MockPluginContext } from "@termix-ssh/plugin-sdk/testing";

/**
 * A stand-in for the OpenBao Secrets service (openbao-secrets.store 1.0.0)
 * that follows its contract (docs/service.md there): every call needs an
 * acting user with Use secrets; a plugin's area needs the key that
 * bindPlugin hands to the plugin's own receiver in ctx.registry; expiresAt
 * may be at most 30 days ahead; an expired secret reads as null.
 */
export interface FakeSecrets {
  /** Secrets as stored: "<area>|<name>" -> value and options. */
  data: Map<string, { value: string; expiresAt: string | null }>;
  /** Every call: method, area label and name. Never a value. */
  calls: Array<{ method: string; area: string; name: string }>;
  /** Users who hold Use secrets. */
  allowed: Set<string>;
  connected: boolean;
  /** The key the fake hands to `pluginId`. */
  keyFor: (pluginId: string) => string;
  /** Sets a secret directly, as a person would in the Secrets tab. */
  seed: (area: string, name: string, value: string) => void;
}

const NAME = /^[A-Za-z0-9._-]{1,200}(?:\/[A-Za-z0-9._-]{1,200}){0,3}$/;
const DAY = 24 * 60 * 60 * 1000;

export type FakeSecretsService = ReturnType<typeof createFakeSecrets>;

export function createFakeSecrets(mock: () => MockPluginContext) {
  const fake: FakeSecrets = {
    data: new Map(),
    calls: [],
    allowed: new Set(["alice", "bob"]),
    connected: true,
    keyFor: (pluginId) =>
      createHash("sha256").update(`fake-master:${pluginId}`).digest("hex"),
    seed: (area, name, value) => {
      fake.data.set(`${area}|${name}`, { value, expiresAt: null });
    },
  };

  function actor(): string {
    const user = mock().ctx.currentActor();
    if (!user) throw new Error("openbao-secrets.store needs an acting user");
    return user;
  }

  function need(): void {
    if (!fake.allowed.has(actor())) {
      const error = new Error(
        'You do not have access to "openbao-secrets.store". It requires the "openbao-secrets.use" permission.',
      ) as Error & { code: string; status: number };
      error.code = "EPLUGINSVCPERM";
      error.status = 403;
      throw error;
    }
  }

  function area(value: unknown): string {
    need();
    if (value === "user") return `user:${actor()}`;
    if (value === "shared") return "shared";
    const plugin = value as { plugin?: unknown; key?: unknown };
    if (
      plugin &&
      typeof plugin.plugin === "string" &&
      typeof plugin.key === "string"
    ) {
      if (plugin.key !== fake.keyFor(plugin.plugin)) {
        throw new Error(
          `the area key is not ${plugin.plugin}'s: call bindPlugin again`,
        );
      }
      return `plugin:${plugin.plugin}`;
    }
    throw new Error('area is "user", "shared" or { plugin, key }');
  }

  function name(value: unknown): string {
    if (typeof value !== "string" || !NAME.test(value)) {
      throw new Error("bad secret name");
    }
    return value;
  }

  const live = (entry: { expiresAt: string | null } | undefined) =>
    entry && (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now());

  return Object.assign(fake, {
    async status() {
      need();
      return { connected: fake.connected, backend: "openbao-kv2" };
    },
    async bindPlugin(pluginId: string) {
      need();
      fake.calls.push({ method: "bind", area: pluginId, name: "" });
      const receiver = mock().ctx.registry.consume<unknown>(
        `${pluginId}.secretsStoreKey`,
      );
      if (typeof receiver !== "function") {
        throw new Error(`plugin ${pluginId} has no receiver`);
      }
      try {
        await (receiver as (key: string) => unknown)(fake.keyFor(pluginId));
      } catch {
        throw new Error(`plugin ${pluginId} refused its area key`);
      }
    },
    async put(
      where: unknown,
      key: unknown,
      value: string,
      options?: { expiresAt?: string | null },
    ) {
      const label = area(where);
      const checked = name(key);
      const expiresAt = options?.expiresAt ?? null;
      if (expiresAt && Date.parse(expiresAt) > Date.now() + 30 * DAY) {
        throw new Error(
          "expiresAt is more than 30 days ahead: the limit is 30 days",
        );
      }
      fake.calls.push({ method: "put", area: label, name: checked });
      fake.data.set(`${label}|${checked}`, { value, expiresAt });
    },
    async get(where: unknown, key: unknown) {
      const label = area(where);
      const checked = name(key);
      fake.calls.push({ method: "get", area: label, name: checked });
      const entry = fake.data.get(`${label}|${checked}`);
      return live(entry) ? entry!.value : null;
    },
    async remove(where: unknown, key: unknown) {
      const label = area(where);
      const checked = name(key);
      fake.calls.push({ method: "remove", area: label, name: checked });
      return fake.data.delete(`${label}|${checked}`);
    },
    async list(where: unknown, prefix = "") {
      const label = area(where);
      return [...fake.data.entries()]
        .filter(([full]) => full.startsWith(`${label}|${prefix}`))
        .map(([full, entry]) => ({
          name: full.slice(label.length + 1),
          createdAt: null,
          updatedAt: null,
          createdBy: null,
          expiresAt: entry.expiresAt,
          note: null,
        }));
    },
    async removePrefix(where: unknown, prefix: string) {
      const label = area(where);
      fake.calls.push({ method: "removePrefix", area: label, name: prefix });
      let removed = 0;
      for (const full of [...fake.data.keys()]) {
        if (full.startsWith(`${label}|${prefix}`)) {
          fake.data.delete(full);
          removed++;
        }
      }
      return removed;
    },
  });
}
