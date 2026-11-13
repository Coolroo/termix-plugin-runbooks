/** The person's side of agent tokens: list, make, change hosts, revoke. */

import type { Router } from "express";
import { InputError } from "../core/errors.js";
import { body, wrap } from "../core/http.js";
import type { TokenHost, TokenRow } from "../runbooks/store/types.js";
import { pathId, type PersonKit } from "../runbooks/person-kit.js";
import { isSshHost } from "../../shared/hosts.js";
import { newToken } from "./tokens.js";

const MAX_TOKEN_HOSTS = 500;

export function registerTokenRoutes(router: Router, kit: PersonKit): void {
  const { ctx, store, actor, tokensRole, sshHostFor } = kit;

  /**
   * The hosts a token may use, as chosen by the person making or editing it:
   * each one must be an SSH host they see and can connect to. Stored as a
   * snapshot, without anything secret.
   */
  async function chooseHosts(input: unknown): Promise<TokenHost[]> {
    if (
      !Array.isArray(input) ||
      input.length === 0 ||
      input.length > MAX_TOKEN_HOSTS ||
      !input.every((id) => Number.isInteger(id) && id > 0)
    ) {
      throw new InputError(
        `hostIds must list 1 to ${MAX_TOKEN_HOSTS} hosts the token may use`,
      );
    }
    const visible = new Map(
      (await ctx.hosts.list()).map((host) => [host.id, host]),
    );
    const chosen: TokenHost[] = [];
    for (const id of [...new Set(input as number[])]) {
      const host = visible.get(id);
      const access = host
        ? await ctx.hosts.checkAccess(id, "connect")
        : { hasAccess: false };
      if (!host || !access.hasAccess) {
        throw new InputError(`you cannot connect to host ${id}`, 403);
      }
      await sshHostFor(id, `you cannot connect to host ${id}`);
      chosen.push({
        id: host.id,
        name: host.name,
        address: host.ip,
        folder: host.folder,
        ssh: true,
      });
    }
    return chosen;
  }

  /**
   * Marks the hosts of tokens made before 1.0.1, which carry no SSH flag,
   * once the person reading the tokens can see them. A remote desktop host
   * found this way is marked false, so agents no longer get it.
   */
  async function flagTokenHosts(tokens: TokenRow[]): Promise<TokenRow[]> {
    const unflagged = tokens.filter(
      (token) =>
        !token.revokedAt &&
        token.hosts.some((host) => typeof host.ssh !== "boolean"),
    );
    if (unflagged.length === 0) return tokens;
    const visible = new Set((await ctx.hosts.list()).map((host) => host.id));
    const known = new Map<number, boolean>();
    let changed = false;
    for (const token of unflagged) {
      let tokenChanged = false;
      const hosts: TokenHost[] = [];
      for (const host of token.hosts) {
        if (typeof host.ssh === "boolean" || !visible.has(host.id)) {
          hosts.push(host);
          continue;
        }
        if (!known.has(host.id)) {
          const full = await ctx.ssh.resolveHost(host.id);
          if (full) known.set(host.id, isSshHost(full));
        }
        const ssh = known.get(host.id);
        if (ssh === undefined) {
          hosts.push(host);
        } else {
          hosts.push({ ...host, ssh });
          tokenChanged = true;
        }
      }
      if (tokenChanged) {
        await store.setTokenHosts(token.id, hosts);
        token.hosts = hosts;
        changed = true;
      }
    }
    if (changed) await store.persist();
    return tokens;
  }

  /**
   * @openapi
   * /plugin-api/runbooks/tokens:
   *   get:
   *     summary: List Runbooks tokens (never the secret)
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The tokens }
   *   post:
   *     summary: Make a token; the secret is in this answer only
   *     tags: [Runbooks]
   *     responses:
   *       201: { description: The token, once }
   */
  router.get(
    "/tokens",
    ...tokensRole,
    wrap(async () =>
      (await flagTokenHosts(await store.listTokens())).map(
        ({ tokenHash: _hash, ...rest }) => rest,
      ),
    ),
  );
  router.post(
    "/tokens",
    ...tokensRole,
    wrap(async (req, res) => {
      const name = body(req).name;
      if (typeof name !== "string" || !name.trim() || name.length > 100) {
        throw new InputError("name is required (at most 100 characters)");
      }
      const hosts = await chooseHosts(body(req).hostIds);
      const made = newToken();
      const id = await store.createToken({
        name: name.trim(),
        tokenHash: made.hash,
        prefix: made.prefix,
        createdBy: actor(),
        hosts,
      });
      await store.persist();
      await ctx.audit.record({
        action: "runbooks_token_create",
        resourceType: "runbooks_token",
        resourceId: String(id),
        resourceName: name.trim(),
        success: true,
        request: req,
      });
      res.status(201);
      return {
        id,
        name: name.trim(),
        prefix: made.prefix,
        hosts,
        token: made.token,
      };
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/tokens/{id}/hosts:
   *   post:
   *     summary: Replace the hosts a token may name in steps
   *     description: >
   *       Body { hostIds }. Each host must be an SSH host you can connect to;
   *       a remote desktop host is refused with 400.
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: The token }
   */
  router.post(
    "/tokens/:id/hosts",
    ...tokensRole,
    wrap(async (req) => {
      const id = pathId(req);
      const token = await store.getToken(id);
      if (!token) throw new InputError("token not found", 404);
      if (token.revokedAt) {
        throw new InputError("this token was revoked", 409);
      }
      const hosts = await chooseHosts(body(req).hostIds);
      await store.setTokenHosts(id, hosts);
      await store.persist();
      await ctx.audit.record({
        action: "runbooks_token_hosts",
        resourceType: "runbooks_token",
        resourceId: String(id),
        resourceName: token.name,
        details: `hosts: ${hosts.map((host) => host.id).join(", ")}`,
        success: true,
        request: req,
      });
      const { tokenHash: _hash, ...rest } = (await store.getToken(id))!;
      return rest;
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/tokens/{id}/revoke:
   *   post:
   *     summary: Revoke a token
   *     tags: [Runbooks]
   *     responses:
   *       200: { description: Revoked }
   */
  router.post(
    "/tokens/:id/revoke",
    ...tokensRole,
    wrap(async (req) => {
      const id = pathId(req);
      if (!(await store.revokeToken(id))) {
        throw new InputError("token not found", 404);
      }
      await store.persist();
      await ctx.audit.record({
        action: "runbooks_token_revoke",
        resourceType: "runbooks_token",
        resourceId: String(id),
        success: true,
        request: req,
      });
      return { ok: true };
    }),
  );
}
