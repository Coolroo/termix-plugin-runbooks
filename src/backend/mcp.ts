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

const CHECKS_HELP =
  "Steps may have checks: rules Runbooks tests on the output when the run ends, so a wrong result is flagged instead of left for the person to spot. Any failed check makes the step failed, even on exit code 0, and the run's checks list says which one failed and why. Four types, each with an optional label shown to the person: " +
  '{"type":"exitCode","equals":0} (Run only; a terminal run has an exit code only if the person entered one); ' +
  '{"type":"contains","text":"active (running)","stream":"stdout"} or notContains (stream stdout, stderr or any, default any; a terminal run has only its pasted output); ' +
  '{"type":"matches","pattern":"^Status: (ok|ready)$"} or notMatches (a JavaScript regular expression, multiline, with a time limit); ' +
  '{"type":"value","name":"version","matches":"^1\\\\.2\\\\."} (a value this step captures; equals or matches, or neither to require that it was captured). At most 20 per step. Checks read the output with its secrets hidden, as the person sees it: test for "token: [secret:api_token]", never for part of a secret.';

const WAIT_HELP =
  "A step may ask the person to wait after the step before it ended (its run finished, or it was marked done or skipped): waitAfterPreviousSeconds (1 to 86400) and an optional short waitReason. For example, restart a service in one step, then give the health-check step waitAfterPreviousSeconds 120 and waitReason 'let the service restart'. The person sees a countdown, and starting early takes an extra confirm. get_runbook shows waitUntil on a step while its timer runs.";

const STDIN_HELP =
  "A step may get its command's standard input (Run only; Send to terminal is refused for it) from one source: " +
  '{"from":"step","step":2,"stream":"stdout"} (the latest finished run of an earlier step, by number: 2, or "3a" for an amendment; refused while it has none or its last run failed, unless you add "allowFailed":true), ' +
  '{"from":"value","name":"build_id"} (a value, with one newline), ' +
  '{"from":"secret","name":"api_token"} (a secret an earlier step of this runbook captured with secretCaptures) or {"from":"secret","library":"shared/registry/password"} ("mine/<name>" or "shared/<name>" from the OpenBao Secrets library, read as the person who runs it). ' +
  'Example: step 1 "cat /etc/app/config.json", step 2 "jq .version" with stdin {"from":"step","step":1,"stream":"stdout"}. ' +
  "Secrets never appear in commands: a command reads them from standard input, such as --password-stdin. The person sees the source, never a secret, and you never get a secret's value.";

const SECRETS_HELP =
  'A step may capture secrets from its output with secretCaptures: [{"name":"api_token","pattern":"token: (\\S+)"}] (the same rules as captures: a JavaScript regular expression, multiline, exactly one capturing group; at most 10). When the run ends done, each match is stored in OpenBao through the OpenBao Secrets plugin for 7 days, and deleted when the runbook is done or abandoned; a pattern that matches nothing fails the step. ' +
  "The secret's value is replaced by [secret:api_token] in the step's output everywhere, and its output is shown only once the run ends. A later step reads it as standard input: " +
  'example: step 2 "vault token create -field=token" with secretCaptures [{"name":"api_token","pattern":"^(\\S+)$"}]; step 3 "docker login -u ci --password-stdin registry.example.com" with stdin {"from":"secret","name":"api_token"}. ' +
  "Secrets never appear in commands, and you never see a value: get_runbook lists secrets as {name, step, set, expiresAt}. It needs the OpenBao Secrets plugin, and the person who runs the step needs its Use secrets permission.";

const AGENT_STEP_HELP =
  'A step may be yours: owner "agent" (default "person"). The person sees "Waiting for the agent" on it and can only skip or reopen it; Termix never runs it. Its command, if any, only says what you will run (no hostId needed). When every earlier step ended (done, failed or skipped), do the work yourself, then call complete_step with outcome done or failed, a short note and the output you got; its checks (contains, notContains, matches, notMatches) test that output. An agent step cannot have captures, secretCaptures, stdin, a wait timer or exitCode checks. Use it for work you do between the person\'s steps, such as reading a dashboard or changing a file in a repository.';

const AMEND_HELP =
  'Amend a step in place instead of adding a fix at the end. kind "replace" makes a fixed version of a step that did not end done (pending, failed or skipped): the new step is 3a right after step 3, and step 3 shows "Replaced by 3a", keeps its runs and counts as ended. kind "substep" adds an extra step 3a (then 3b) after step 3 in any state. Later steps keep their numbers. An amendment can be amended too: replace 3a with 3b. reason (up to 500 characters) is shown on the new step. step has the fields of a new step and the same checks. Refused: a closed runbook (409), a step whose run is running (409 running), replace of a step that ended done (409 done: use substep) or was already replaced (409 replaced: amend its replacement). A later step names an amendment in stdin as "3a".';

const WHERE_HELP =
  'Where the person runs the command when it is not a shell on a Termix host, up to 80 characters: for example "Windows PC, PowerShell as admin" or "browser console on the admin page". A person step with command and where and no hostId shows "Run outside Termix: <where>", the command with its values filled in and a Copy button; Termix never runs it. The person pastes the output and marks the step done or failed; checks (not exitCode) and captures read the pasted output. Not with stdin or secretCaptures. Use it instead of a code block in body for a command that runs outside Termix.';

const OWNER_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  description:
    "Who the runbook belongs to, shown to the person under its title: task (up to 64 characters, such as T-42), agent (up to 200, an address of your session that a notification receiver understands) and label (up to 80, your name as the person sees it). Null clears it.",
  properties: {
    task: { type: "string", maxLength: 64 },
    agent: { type: "string", maxLength: 200 },
    label: { type: "string", maxLength: 80 },
  },
};

const EVENTS_HELP =
  "Runbooks records events: agent-turn (one of your agent steps became the next step: every earlier step ended), step-failed (a step ended failed; reason exit, check, stopped, interrupted, secret or manual), runbook-done (reason done or abandoned), sent (the person pressed Send to agent on a step, maybe with a note) step-done (a step ended done; only when notify lists it) and amended (you amended a step: reason replace or substep; only when notify lists it). notify on a runbook lists the types the notification webhook delivers (default agent-turn, step-failed, runbook-done, sent; sent always goes). Events hold ids only: read the runbook for output and notes.";

const NOTIFY_SCHEMA = {
  type: ["array", "null"],
  description: `Event types to deliver for this runbook. Null keeps the default. ${EVENTS_HELP}`,
  items: {
    type: "string",
    enum: [
      "agent-turn",
      "step-failed",
      "runbook-done",
      "sent",
      "step-done",
      "amended",
    ],
  },
};

const STDIN_SCHEMA = {
  type: ["object", "null"],
  description: STDIN_HELP,
  required: ["from"],
  properties: {
    from: { type: "string", enum: ["step", "value", "secret"] },
    step: {
      type: ["integer", "string"],
      description:
        'step: the number of an earlier step: 2, or "3a" for an amendment.',
    },
    stream: { type: "string", enum: ["stdout", "stderr"] },
    allowFailed: {
      type: "boolean",
      description: "step: also use the output of a failed run.",
    },
    name: {
      type: "string",
      description:
        "value: a value name. secret: a secret this runbook captures.",
    },
    library: {
      type: "string",
      description: 'secret: "mine/<name>" or "shared/<name>".',
    },
  },
};

const CHECK_SCHEMA = {
  type: "object",
  required: ["type"],
  properties: {
    type: {
      type: "string",
      enum: [
        "exitCode",
        "contains",
        "notContains",
        "matches",
        "notMatches",
        "value",
      ],
    },
    label: { type: "string", description: "Shown to the person." },
    equals: {
      type: ["integer", "string"],
      description:
        "exitCode: the exit code. value: the text the value must be.",
    },
    text: { type: "string", description: "contains, notContains." },
    pattern: {
      type: "string",
      description: "matches, notMatches: a JavaScript regular expression.",
    },
    stream: { type: "string", enum: ["stdout", "stderr", "any"] },
    name: { type: "string", description: "value: one of the step's captures." },
    matches: {
      type: "string",
      description: "value: a regular expression the value must match.",
    },
  },
};

const STEP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: { type: "string", description: "Short name of the step." },
    owner: {
      type: "string",
      enum: ["person", "agent"],
      description: AGENT_STEP_HELP,
    },
    body: {
      type: "string",
      description: "Markdown shown before the command: why and what to check.",
    },
    hostId: {
      type: ["integer", "null"],
      description:
        "Host to run the command on, from list_hosts. Null or absent for a manual step (text only, no command), and for a command the person runs outside Termix (set where).",
    },
    where: {
      type: ["string", "null"],
      maxLength: 80,
      description: WHERE_HELP,
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
    checks: {
      type: "array",
      maxItems: 20,
      description: CHECKS_HELP,
      items: CHECK_SCHEMA,
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
    waitAfterPreviousSeconds: {
      type: ["integer", "null"],
      minimum: 1,
      maximum: 86400,
      description:
        "Seconds the person should wait after the previous step ended before starting this one, such as 120 after a restart.",
    },
    waitReason: {
      type: ["string", "null"],
      maxLength: 500,
      description:
        "Why to wait, shown with the countdown, such as 'let the service restart'. Needs waitAfterPreviousSeconds.",
    },
    stdin: STDIN_SCHEMA,
    secretCaptures: {
      type: "array",
      maxItems: 10,
      description: SECRETS_HELP,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "pattern"],
        properties: {
          name: {
            type: "string",
            pattern: "^[A-Za-z_][A-Za-z0-9_.-]*$",
            maxLength: 64,
          },
          pattern: { type: "string" },
        },
      },
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
    description: `Read one runbook: its steps in order with their status, the owner's notes, and every run of each step (newest first) with who ran it, when, the exact command, exit code, stdout and stderr (or pasted terminal output), and the result of each check ({label, ok, detail}). A run still in progress has running: true, the stdout and stderr that arrived so far, and lastOutputAt (when it last printed); read again to follow it. Output of steps the owner hid reads '[hidden by owner]'. A secret value reads [secret:<name>]; secrets lists each secret the steps capture as {name, step, set, expiresAt}, and a run's stdin and secrets say where its input came from and which secrets it read or stored, by name only. Each step has a label (3, or 3a for an amendment), amendment ({kind, reason, by, stepId, stepLabel, oldCommand} or null) and replacedBy ({id, label} on a replaced step). Use it to see what happened after the owner ran steps. ${OPEN_LINK}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runbookId"],
      properties: { runbookId: ID("The runbook id.") },
    },
  },
  {
    name: "create_runbook",
    description: `Propose a new runbook. Steps are proposals: you never run them. The owner reads each step in Termix, sees the host and the exact resolved command, and runs it or skips it; the output is stored on the step. ${VALUE_SYNTAX} Prefer checks over only describing the expected output in expect. ${WAIT_HELP} ${STDIN_HELP} ${SECRETS_HELP} ${AGENT_STEP_HELP} Set owner so the person knows who to talk to. Returns the runbook as get_runbook does. ${OPEN_LINK} Give the person that link when you are done.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: {
        title: { type: "string" },
        owner: OWNER_SCHEMA,
        notify: NOTIFY_SCHEMA,
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
    description: `Change a runbook's title, summary, values, status (open, done, abandoned) or owner. Values replace the whole author value set. A changed value changes the resolved commands, so the owner sees the new text before running. ${OPEN_LINK}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runbookId"],
      properties: {
        runbookId: ID("The runbook id."),
        owner: OWNER_SCHEMA,
        notify: NOTIFY_SCHEMA,
        title: { type: "string" },
        summary: { type: "string" },
        values: { type: "object", additionalProperties: { type: "string" } },
        status: { type: "string", enum: ["open", "done", "abandoned"] },
      },
    },
  },
  {
    name: "add_steps",
    description: `Add steps to an open runbook, at the end or at a 1-based position. Steps cannot go before a step that already ran. ${VALUE_SYNTAX} ${CHECKS_HELP} ${WAIT_HELP} ${STDIN_HELP} ${SECRETS_HELP}`,
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
    description: `Change a step that has not run yet. A step that already ran is history and cannot change (error 409): amend it with amend_step instead, also to change its checks. Only the given fields change; checks replaces the whole list. ${CHECKS_HELP} ${WAIT_HELP}`,
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
    name: "amend_step",
    description: `${AMEND_HELP} Returns the runbook as get_runbook does. ${CHECKS_HELP} ${STDIN_HELP}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["stepId", "kind", "reason", "step"],
      properties: {
        stepId: ID("The step to amend."),
        kind: {
          type: "string",
          enum: ["replace", "substep"],
          description:
            "replace: a fixed version of a step that did not end done. substep: an extra step after it.",
        },
        reason: {
          type: "string",
          maxLength: 500,
          description:
            "Why, in one line. The person sees it on the new step: Amended by <your token name>: <reason>.",
        },
        step: STEP_SCHEMA,
      },
    },
  },
  {
    name: "remove_step",
    description:
      "Remove a step that has not run yet. A step with amendments, and a fixed version (kind replace), stay: amend them instead.",
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
      "Put the steps of an open runbook in a new order. List every step id once, without amendments (3a): they move with their step. Steps that already ran keep their position.",
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
    name: "list_events",
    description: `List events of your runbooks, oldest first, after the event id since (default 0), at most limit (default 100, up to 500). Answers { events, next }: call again with since = next to read on. Each event has id, type, reason, runbookId, stepId, stepPosition, note (a sent event's note), createdBy, createdAt and openPath. get_runbook also lists a runbook's latest events, newest first. ${EVENTS_HELP}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        since: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: "complete_step",
    description:
      "End one of your own steps (owner \"agent\") when it is your turn: every earlier step ended (done, failed or skipped). outcome is done or failed; note (up to 2000 characters) says what you did; output (up to 64 KB) is what you got, and the step's checks test it, so a failed check makes the step failed. Refused for a person's step (403), before your turn (409 order), and for a step that already ended (409). The person sees the note and the output. Returns the runbook as get_runbook does.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["stepId", "outcome"],
      properties: {
        stepId: ID("The step id."),
        outcome: { type: "string", enum: ["done", "failed"] },
        note: { type: "string", maxLength: 2000 },
        output: { type: "string" },
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
