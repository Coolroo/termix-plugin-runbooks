/**
 * What every route file needs from Express: a handler that turns an
 * InputError into its status, the id in the path, the body, and the two
 * gates of a person's request (signed in, not a Termix API key). Each side
 * keeps its own words.
 */

import type { NextFunction, Request, Response } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { InputError } from "./errors.js";

export type Handler = (req: Request, res: Response) => Promise<void>;

/**
 * Answers with what `fn` returns, as JSON, unless it answered itself. An
 * InputError becomes its status and { error, ...extra }; anything else is
 * core's 500.
 */
export function wrap(
  fn: (req: Request, res: Response) => Promise<unknown>,
): Handler {
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

/** The positive integer :id in the path; 404 with `message` otherwise. */
export function idParam(req: Request, message: string): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new InputError(message, 404);
  return id;
}

/** The request body as an object; {} when there is none. */
export function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object"
    ? (req.body as Record<string, unknown>)
    : {};
}

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

/** 401 with `message` unless an acting user is set (core does after login). */
export function requireSignedIn(
  ctx: PluginContext,
  message: string,
): Middleware {
  return (_req, res, next) => {
    if (!ctx.currentActor()) {
      res.status(401).json({ error: message });
      return;
    }
    next();
  };
}

/** Whether the request came in on a core API key (tmx_...). */
function isApiKey(req: Request): boolean {
  return Boolean((req as Request & { apiKeyId?: unknown }).apiKeyId);
}

/** 403 with `message` for a request on a core API key. */
export function refuseApiKey(message: string): Middleware {
  return (req, res, next) => {
    if (isApiKey(req)) {
      res.status(403).json({ error: message });
      return;
    }
    next();
  };
}
