/**
 * The agent side: /plugin-api/runbooks/agent/... and the MCP endpoint.
 *
 * These routes are declared public to core, so core does no login check and
 * sets no acting user. Every request must instead carry
 * "Authorization: Bearer rbk_..." for a live Runbooks token whose creator
 * still holds runbooks.use. The agent then acts within that creator's hosts.
 */

import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { AgentCaller, AgentOps } from "./agent-ops.js";
import { handleMessage } from "./mcp.js";
import { InputError } from "./service.js";
import type { Store } from "./store.js";
import { bearer, checkToken, createRateLimiter } from "./tokens.js";

export const AGENT_RATE_LIMIT = 120;

type Handler = (req: Request, res: Response) => Promise<void>;

function caller(res: Response): AgentCaller {
  return res.locals.caller as AgentCaller;
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new InputError("bad id", 404);
  return id;
}

/** Turns an InputError into its status; anything else is core's 500. */
function wrap(fn: (req: Request, res: Response) => Promise<unknown>): Handler {
  return async (req, res) => {
    try {
      const body = await fn(req, res);
      if (!res.headersSent) res.json(body);
    } catch (error) {
      if (error instanceof InputError) {
        res.status(error.status).json({ error: error.message, ...error.extra });
        return;
      }
      throw error;
    }
  };
}

export function createAgentRouter(
  ctx: PluginContext,
  store: Store,
  ops: AgentOps,
  version: string,
): { router: Router; limiter: ReturnType<typeof createRateLimiter> } {
  const router = express.Router();
  const limiter = createRateLimiter(AGENT_RATE_LIMIT);

  router.use(async (req: Request, res: Response, next: NextFunction) => {
    const check = await checkToken(store, bearer(req.headers.authorization));
    if (!check.ok) {
      const { reason } = check as { reason: string };
      res.setHeader("WWW-Authenticate", 'Bearer realm="runbooks"');
      const message =
        reason === "missing"
          ? "a Runbooks token is required: Authorization: Bearer rbk_..."
          : reason === "revoked"
            ? "this Runbooks token was revoked"
            : "this Runbooks token is not valid";
      res.status(401).json({ error: message });
      return;
    }
    if (limiter.over(check.token.id)) {
      res.setHeader("Retry-After", "60");
      res
        .status(429)
        .json({ error: `at most ${AGENT_RATE_LIMIT} requests a minute` });
      return;
    }
    if (!(await ctx.rbac.hasFor(check.token.createdBy, "use"))) {
      res.status(403).json({
        error: "the person who made this token can no longer use Runbooks",
      });
      return;
    }
    res.locals.caller = { token: check.token } satisfies AgentCaller;
    await store.markTokenUsed(check.token.id);
    await store.persist(true);
    next();
  });

  /**
   * @openapi
   * /plugin-api/runbooks/agent/hosts:
   *   get:
   *     summary: Hosts the token's creator can use (id, name, address, folder)
   *     tags: [Runbooks agent]
   *     security: [{ runbooksToken: [] }]
   *     responses:
   *       200: { description: The hosts }
   *       401: { description: Missing, invalid or revoked token }
   */
  router.get(
    "/hosts",
    wrap(async (_req, res) => ops.listHosts(caller(res))),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/agent/runbooks:
   *   get:
   *     summary: List the token creator's runbooks, with progress
   *     tags: [Runbooks agent]
   *     parameters:
   *       - in: query
   *         name: status
   *         schema: { type: string, enum: [open, done, abandoned] }
   *     responses:
   *       200: { description: The runbooks }
   *   post:
   *     summary: Propose a runbook with its steps
   *     tags: [Runbooks agent]
   *     responses:
   *       201: { description: The new runbook }
   *       400: { description: Invalid input }
   */
  router.get(
    "/runbooks",
    wrap(async (req, res) =>
      ops.listRunbooks(caller(res), { status: req.query.status }),
    ),
  );
  router.post(
    "/runbooks",
    wrap(async (req, res) => {
      const created = await ops.createRunbook(caller(res), req.body);
      res.status(201);
      return created;
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/agent/runbooks/{id}:
   *   get:
   *     summary: One runbook with its steps, runs and outputs
   *     tags: [Runbooks agent]
   *     responses:
   *       200: { description: The runbook }
   *       404: { description: Not found }
   *   patch:
   *     summary: Change title, summary, values or status
   *     tags: [Runbooks agent]
   *     responses:
   *       200: { description: The runbook }
   */
  router.get(
    "/runbooks/:id",
    wrap(async (req, res) => ops.getRunbook(caller(res), idParam(req))),
  );
  router.patch(
    "/runbooks/:id",
    wrap(async (req, res) =>
      ops.updateRunbook(caller(res), idParam(req), req.body),
    ),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/agent/runbooks/{id}/steps:
   *   post:
   *     summary: Add steps, at the end or at a position
   *     tags: [Runbooks agent]
   *     responses:
   *       201: { description: The runbook }
   *       409: { description: Would move a step that already ran }
   */
  router.post(
    "/runbooks/:id/steps",
    wrap(async (req, res) => {
      const updated = await ops.addSteps(caller(res), idParam(req), req.body);
      res.status(201);
      return updated;
    }),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/agent/runbooks/{id}/reorder:
   *   post:
   *     summary: Put the steps in a new order
   *     tags: [Runbooks agent]
   *     responses:
   *       200: { description: The runbook }
   */
  router.post(
    "/runbooks/:id/reorder",
    wrap(async (req, res) =>
      ops.reorderSteps(caller(res), idParam(req), req.body),
    ),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/agent/runbooks/{id}/values:
   *   get:
   *     summary: Effective values (author values and captures)
   *     tags: [Runbooks agent]
   *     responses:
   *       200: { description: The values }
   */
  router.get(
    "/runbooks/:id/values",
    wrap(async (req, res) => ops.getValues(caller(res), idParam(req))),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/agent/steps/{id}:
   *   patch:
   *     summary: Change a step that has not run
   *     tags: [Runbooks agent]
   *     responses:
   *       200: { description: The runbook }
   *       409: { description: The step already ran }
   *   delete:
   *     summary: Remove a step that has not run
   *     tags: [Runbooks agent]
   *     responses:
   *       200: { description: The runbook }
   *       409: { description: The step already ran }
   */
  router.patch(
    "/steps/:id",
    wrap(async (req, res) =>
      ops.updateStep(caller(res), idParam(req), req.body),
    ),
  );
  router.delete(
    "/steps/:id",
    wrap(async (req, res) => ops.removeStep(caller(res), idParam(req))),
  );

  /**
   * @openapi
   * /plugin-api/runbooks/agent/mcp:
   *   post:
   *     summary: MCP over streamable HTTP (JSON-RPC 2.0, JSON answers)
   *     tags: [Runbooks agent]
   *     responses:
   *       200: { description: The JSON-RPC answer }
   *       202: { description: A notification, no answer }
   */
  router.post("/mcp", async (req: Request, res: Response) => {
    const body = req.body;
    const messages = Array.isArray(body) ? body : [body];
    if (messages.length === 0) {
      res.status(400).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
      });
      return;
    }
    const answers: unknown[] = [];
    for (const message of messages) {
      const answer = await handleMessage(ops, caller(res), message, version);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) {
      res.status(202).end();
      return;
    }
    res.json(Array.isArray(body) ? answers : answers[0]);
  });
  // No server-sent event stream: answers come back on the POST.
  router.get("/mcp", (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "use POST" });
  });

  return { router, limiter };
}
