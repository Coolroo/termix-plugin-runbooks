/**
 * A small MCP server over streamable HTTP: JSON-RPC 2.0 in a POST, one JSON
 * answer back, no server-sent events. Enough for an agent to use the tools
 * (tools.ts) with the same token as the REST routes.
 */

import type { AgentOps } from "../ops/ops.js";
import type { AgentCaller } from "../ops/access.js";
import { InputError } from "../../core/errors.js";
import { TOOLS } from "./tools.js";

const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Args = Record<string, unknown>;

function int(args: Args, key: string): number {
  const value = args[key];
  if (!Number.isInteger(value))
    throw new InputError(`${key} must be an integer`);
  return value as number;
}

function without(args: Args, ...keys: string[]): Args {
  const copy = { ...args };
  for (const key of keys) delete copy[key];
  return copy;
}

async function callTool(
  ops: AgentOps,
  caller: AgentCaller,
  name: string,
  args: Args,
): Promise<unknown> {
  switch (name) {
    case "list_hosts":
      return ops.listHosts(caller);
    case "list_runbooks":
      return ops.listRunbooks(caller, { status: args.status });
    case "get_runbook":
      return ops.getRunbook(caller, int(args, "runbookId"));
    case "create_runbook":
      return ops.createRunbook(caller, args);
    case "update_runbook":
      return ops.updateRunbook(
        caller,
        int(args, "runbookId"),
        without(args, "runbookId"),
      );
    case "add_steps":
      return ops.addSteps(caller, int(args, "runbookId"), {
        steps: args.steps,
        position: args.position,
      });
    case "update_step":
      return ops.updateStep(
        caller,
        int(args, "stepId"),
        without(args, "stepId"),
      );
    case "remove_step":
      return ops.removeStep(caller, int(args, "stepId"));
    case "reorder_steps":
      return ops.reorderSteps(caller, int(args, "runbookId"), {
        stepIds: args.stepIds,
      });
    case "get_values":
      return ops.getValues(caller, int(args, "runbookId"));
    case "list_events":
      return ops.listEvents(caller, { since: args.since, limit: args.limit });
    case "amend_step":
      return ops.amendStep(caller, int(args, "stepId"), {
        kind: args.kind,
        reason: args.reason,
        step: args.step,
      });
    case "complete_step":
      return ops.completeAgentStep(
        caller,
        int(args, "stepId"),
        without(args, "stepId"),
      );
    default:
      throw new UnknownTool(name);
  }
}

class UnknownTool extends Error {}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const INVALID_REQUEST = -32600;

const METHOD_NOT_FOUND = -32601;

const INVALID_PARAMS = -32602;

const INTERNAL_ERROR = -32603;

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/**
 * Answers one JSON-RPC message, or null for a notification (no id), which
 * gets no answer.
 */
export async function handleMessage(
  ops: AgentOps,
  caller: AgentCaller,
  message: unknown,
  serverVersion: string,
): Promise<unknown | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, INVALID_REQUEST, "Invalid request");
  }
  const request = message as JsonRpcRequest;
  const isNotification = !("id" in request);
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return isNotification
      ? null
      : rpcError(request.id, INVALID_REQUEST, "Invalid request");
  }
  const params = (request.params ?? {}) as Args;

  if (isNotification) return null;

  const result = (value: unknown) => ({
    jsonrpc: "2.0",
    id: request.id,
    result: value,
  });

  switch (request.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion =
        typeof asked === "string" && MCP_PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : MCP_PROTOCOL_VERSIONS[0];
      return result({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "termix-runbooks", version: serverVersion },
        instructions:
          "Runbooks in Termix. You propose runbooks and steps; a person runs each step after reading the exact command, and the output is stored. You can never run a person's step. Steps with owner agent are yours: do them when it is your turn and end them with complete_step. Read get_runbook to see results. To fix a step or add one between steps, amend it with amend_step instead of adding steps at the end. Give the person a link to each runbook you make: the Termix address followed by the runbook's openPath.",
      });
    }
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: TOOLS });
    case "tools/call": {
      const name = params.name;
      const args = (params.arguments ?? {}) as Args;
      if (typeof name !== "string") {
        return rpcError(request.id, INVALID_PARAMS, "params.name is required");
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return rpcError(
          request.id,
          INVALID_PARAMS,
          "params.arguments must be an object",
        );
      }
      try {
        const value = await callTool(ops, caller, name, args);
        return result({
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          structuredContent: Array.isArray(value) ? { items: value } : value,
          isError: false,
        });
      } catch (error) {
        if (error instanceof UnknownTool) {
          return rpcError(request.id, INVALID_PARAMS, `Unknown tool: ${name}`);
        }
        if (error instanceof InputError) {
          return result({
            content: [
              { type: "text", text: `Error ${error.status}: ${error.message}` },
            ],
            isError: true,
          });
        }
        return rpcError(request.id, INTERNAL_ERROR, "Tool failed");
      }
    }
    default:
      return rpcError(
        request.id,
        METHOD_NOT_FOUND,
        `Method not found: ${request.method}`,
      );
  }
}
