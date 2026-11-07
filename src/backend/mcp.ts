/**
 * A small MCP server over streamable HTTP: JSON-RPC 2.0 in a POST, one JSON
 * answer back, no server-sent events. Enough for an agent to use the tools
 * below with the same token as the REST routes.
 */

import type { AgentCaller, AgentOps } from "./agent-ops.js";
import { InputError } from "./service.js";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const VALUE_SYNTAX =
  "Commands may use {{name}} placeholders. Each is replaced, as plain text and without shell quoting, by the runbook's value of that name: the author's values first, then values captured from earlier steps' output (a later capture wins). The person sees the resolved command before running it; a step whose placeholders have no value cannot run.";

const OPEN_LINK =
  "Each runbook has openPath, a link relative to the Termix address: give the person the Termix address followed by openPath (for example https://termix.example.com/?view=runbook&id=12). It opens that runbook in the Runbooks tab, after a sign-in if needed.";

const STEP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: { type: "string", description: "Short name of the step." },
    body: {
      type: "string",
      description: "Markdown shown before the command: why and what to check.",
    },
    hostId: {
      type: ["integer", "null"],
      description:
        "Host to run the command on, from list_hosts. Null or absent for a manual step (text only, no command).",
    },
    command: {
      type: ["string", "null"],
      description: `Shell command, run with the host's stored login. ${VALUE_SYNTAX}`,
    },
    expect: {
      type: "string",
      description: "Markdown: what the person should see when the step works.",
    },
    captures: {
      type: "array",
      description:
        "Values to take from the command's standard output after it runs: a JavaScript regular expression (multiline mode) with exactly one capturing group; the first match's group becomes the value `name` for later steps.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "pattern"],
        properties: {
          name: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_.-]*$" },
          pattern: { type: "string" },
        },
      },
    },
    hideOutputFromAgents: {
      type: "boolean",
      description:
        "True when the output may hold secrets: agents then see '[hidden by owner]' instead of the output and of values captured from it.",
    },
    timeoutMs: {
      type: ["integer", "null"],
      minimum: 1000,
      maximum: 600000,
      description: "Time limit for the command. Default 120000.",
    },
  },
};

const ID = (description: string) => ({ type: "integer", description });

export const TOOLS = [
  {
    name: "list_hosts",
    description:
      "List the Termix SSH hosts this token may use, as chosen by the person who made it: id, name, address and folder. A step's hostId must be one of these ids.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_runbooks",
    description: `List the runbooks made with tokens of this token's creator, newest change first, with progress (finished and total steps). ${OPEN_LINK}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["open", "done", "abandoned"],
          description: "Only runbooks with this status.",
        },
      },
    },
  },
  {
    name: "get_runbook",
    description: `Read one runbook: its steps in order with their status, the owner's notes, and every run of each step (newest first) with who ran it, when, the exact command, exit code, stdout and stderr (or pasted terminal output). Output of steps the owner hid reads '[hidden by owner]'. Use it to see what happened after the owner ran steps. ${OPEN_LINK}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runbookId"],
      properties: { runbookId: ID("The runbook id.") },
    },
  },
  {
    name: "create_runbook",
    description: `Propose a new runbook. Steps are proposals: you never run them. The owner reads each step in Termix, sees the host and the exact resolved command, and runs it or skips it; the output is stored on the step. ${VALUE_SYNTAX} Returns the runbook as get_runbook does. ${OPEN_LINK} Give the person that link when you are done.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: {
        title: { type: "string" },
        summary: {
          type: "string",
          description: "Markdown: what the runbook does and why.",
        },
        values: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Named values for {{name}} placeholders.",
        },
        steps: { type: "array", items: STEP_SCHEMA },
      },
    },
  },
  {
    name: "update_runbook",
    description: `Change a runbook's title, summary, values or status (open, done, abandoned). Values replace the whole author value set. A changed value changes the resolved commands, so the owner sees the new text before running. ${OPEN_LINK}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runbookId"],
      properties: {
        runbookId: ID("The runbook id."),
        title: { type: "string" },
        summary: { type: "string" },
        values: { type: "object", additionalProperties: { type: "string" } },
        status: { type: "string", enum: ["open", "done", "abandoned"] },
      },
    },
  },
  {
    name: "add_steps",
    description: `Add steps to an open runbook, at the end or at a 1-based position. Steps cannot go before a step that already ran. ${VALUE_SYNTAX}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runbookId", "steps"],
      properties: {
        runbookId: ID("The runbook id."),
        position: {
          type: "integer",
          minimum: 1,
          description: "Where the first new step goes. Default: the end.",
        },
        steps: { type: "array", items: STEP_SCHEMA, minItems: 1 },
      },
    },
  },
  {
    name: "update_step",
    description:
      "Change a step that has not run yet. A step that already ran is history and cannot change (error 409): add a new step instead. Only the given fields change.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["stepId"],
      properties: {
        stepId: ID("The step id."),
        ...STEP_SCHEMA.properties,
      },
    },
  },
  {
    name: "remove_step",
    description: "Remove a step that has not run yet.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["stepId"],
      properties: { stepId: ID("The step id.") },
    },
  },
  {
    name: "reorder_steps",
    description:
      "Put the steps of an open runbook in a new order. List every step id once; steps that already ran keep their position.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runbookId", "stepIds"],
      properties: {
        runbookId: ID("The runbook id."),
        stepIds: { type: "array", items: { type: "integer" } },
      },
    },
  },
  {
    name: "get_values",
    description:
      "Read a runbook's effective values: the author's values and the values captured from step output, with where each came from. Values captured from hidden steps read '[hidden by owner]'.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runbookId"],
      properties: { runbookId: ID("The runbook id.") },
    },
  },
];

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

export async function callTool(
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
          "Runbooks in Termix. You propose runbooks and steps; a person runs each step after reading the exact command, and the output is stored. You can never run a step. Read get_runbook to see results. Give the person a link to each runbook you make: the Termix address followed by the runbook's openPath.",
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
