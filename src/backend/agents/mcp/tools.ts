/**
 * The MCP tools an agent sees: their names, help texts and input schemas.
 * The schemas' patterns come from the server's own rules.
 */

import {
  EVENT_LIMITS,
  EVENT_TYPES,
  LOOPBACK_HOSTS,
} from "../../../shared/events.js";
import { APP_FIELD, APP_PART } from "../../../shared/secret-steps.js";
import { LIBRARY_REF, MAX_SECRET_NAME, NAME } from "../../../shared/names.js";
import { OPTION_ID } from "../../../shared/decisions.js";
import { MAX_FOLDER } from "../../../shared/folders.js";
import { SEQUENCE_LIMITS } from "../../../shared/sequence.js";
import {
  BACKOFFS,
  JITTERS,
  RETRY_ON,
  SCHEDULE_LIMITS,
} from "../../../shared/schedule.js";
import {
  MAX_VM_VALUE,
  MAX_WAIT_SECONDS,
  VM_ACTIONS,
  VM_NAME,
  VM_STATES,
} from "../../../shared/vms.js";

const VALUE_SYNTAX =
  'Commands and checks may use {{name}} placeholders. Each is replaced, as plain text and without shell quoting, by the runbook\'s value of that name: the author\'s values first, then values captured from earlier steps\' output (a later capture wins). In a check, contains and notContains text and a value check\'s equals get the value as it is, and a pattern (matches, notMatches, a value check\'s matches) gets it as literal text, escaped, so {"type":"contains","text":"image:{{ver}}@sha256:"} works. The person sees the resolved command before running it; a step whose placeholders, in its command or its checks, have no value cannot run. ' +
  'A value a step or an item captures from a host\'s output may go into a command (a step\'s or item\'s command, an event\'s name, path or URL) only when the step or item that captures it checks it with a pattern: {"type":"value","name":"ver","matches":"^[0-9.]+$"}; otherwise the runbook is refused (400, code captured-value). A value that does not match fails the capturing step, and a later item takes it only when it matches as a whole. Your own values, and a VM step\'s values, need no pattern.';

const TEXT_VALUES =
  "{{name}} values work here too, with the command's values: get_runbook returns the text as written and resolved (resolvedBody, resolvedExpect, resolvedWhere; textMissing names values not set yet, which show to the person as not set and do not stop the step). In Markdown a value shows as text (its Markdown is escaped), and inside a code span or code block as it is. Secrets are never values.";

const OPEN_LINK =
  "Each runbook has openPath, a link relative to the Termix address: give the person the Termix address followed by openPath (for example https://termix.example.com/?view=runbook&id=12). It opens that runbook in the Runbooks tab, after a sign-in if needed.";

const CHECKS_HELP =
  "Steps may have checks: rules Runbooks tests on the output when the run ends, so a wrong result is flagged instead of left for the person to spot. Any failed check makes the step failed, even on exit code 0, and the run's checks list says which one failed and why. Four types, each with an optional label shown to the person: " +
  '{"type":"exitCode","equals":0} (Run only; a terminal run has an exit code only if the person entered one); ' +
  '{"type":"contains","text":"active (running)","stream":"stdout"} or notContains (stream stdout, stderr or any, default any; a terminal run has only its pasted output); ' +
  '{"type":"matches","pattern":"^Status: (ok|ready)$"} or notMatches (a JavaScript regular expression, multiline, with a time limit); ' +
  '{"type":"value","name":"version","matches":"^1\\\\.2\\\\."} (a value this step captures; equals or matches, or neither to require that it was captured). At most 20 per step. Checks take {{name}} values as commands do: text as it is, a pattern as escaped literal text, and a check whose value is not set stops the step from running. Checks read the output with its secrets hidden, as the person sees it: test for "token: [secret:api_token]", never for part of a secret.';

const WHEN_HELP =
  "When the step is needed (1.4.6), as a rule on earlier steps only; use it instead of 'only if step 8 failed' in the title or body. Leaves: " +
  '{"step":8,"status":"failed"} (status done, failed, skipped, ran or not-needed; step 3 or "3a"), ' +
  '{"step":1,"output":{"type":"contains","text":"HTTPS certificates: OFF"}} (any check type, on that step\'s latest finished run, secrets hidden; {{name}} values work), ' +
  '{"value":"mode","equals":"fast"} or "matches" (a runbook value), {"step":5,"chose":"rollback"} (an option the person chose in a decision step). Combine with {"all":[...]}, {"any":[...]} and {"not":rule}, at most 4 levels and 20 rules. ' +
  "Runbooks works the state out each time the runbook is read: waiting (a step it names has not ended), met, or not-met. A pending step whose rule is not met reads as not needed and counts as ended for the order, the next step, the progress and agent-turn. A rule that names a step an amendment replaced reads the replacement. get_runbook shows when and condition { state, rule, reason, notNeeded } on each step. A step a rule names cannot be removed or moved after the step with the rule. A rule cannot read a step whose output is hidden from agents, or a value such a step captures (also as {{name}}): test its status instead. An output rule cannot read stream stderr of an interactive step.";

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

const SECRET_STEPS_HELP =
  "Make a secret and Ask for a secret steps (a person's step with no command): instead of telling the person to make a password or copy a token by hand, " +
  'give the step generate {"name":"db_password","format":"alnum","length":32} (formats: alnum letters and digits 16-128, default 32; hex 16-128, default 64; base64url 16-128, default 43; words 4-12 words from the EFF long list joined by "-", default 6; pin 4-12 digits, default 6) ' +
  'or ask {"name":"cf_token","label":"Cloudflare API token","pattern":"[A-Za-z0-9_-]{40}"} (the person types or pastes it once; pattern, optional, must match the whole value, trimmed). ' +
  "The person clicks Make it or Save; the server makes or takes the value and stores it, and nobody sees it again: not the page, not you, not an event, the audit log or any output. " +
  'Where it goes, store: "runbook" (default: the runbook\'s own secrets for 7 days, deleted when the runbook ends; a later step reads it with stdin {"from":"secret","name":"db_password"}), ' +
  '{"library":"mine/<path>" or "shared/<path>","expires":<days 1-30, optional>} (the OpenBao Secrets library, never replacing a secret that exists; read it with stdin {"from":"secret","library":"mine/<path>"}), ' +
  'or {"app":"<app>/<host>","field":"<field>"} (a new field at the app secrets folder OpenBao Secrets 1.0.5 writes for other programs, only for app paths its admin allows; never read back). ' +
  "Later outputs hide the value as [secret:<name>]. The step's run says Made secret <name> or Saved secret <name>, never the value. You can never make, save or complete such a step: it is always the person's. Without OpenBao Secrets connected (or an app store it cannot reach), the person sees by-hand instructions instead (engine, path, field, and for generate the format and length to make with a password manager) and marks the step Done, and a later step that reads the secret says where to get it. " +
  "Not with owner agent, command, hostId, where, stdin, captures, secretCaptures or checks; a step has generate or ask, not both.";

/**
 * Schema patterns come from the regular expressions the server checks with,
 * so what an agent is told never drifts from what it refuses. The server
 * checks each part of "<app>/<host>" on its own; the schema joins two.
 */
const APP_PART_BODY = APP_PART.source.slice(1, -1);

const APP_PATH = `^${APP_PART_BODY}/${APP_PART_BODY}$`;

const STORE_SCHEMA = {
  description:
    'Where the value goes: "runbook" (default), {"library":"mine/<path>"|"shared/<path>","expires":days} or {"app":"<app>/<host>","field":"<field>"}.',
  oneOf: [
    { type: "string", enum: ["runbook"] },
    {
      type: "object",
      additionalProperties: false,
      required: ["library"],
      properties: {
        library: {
          type: "string",
          pattern: LIBRARY_REF.source,
        },
        expires: { type: "integer", minimum: 1, maximum: 30 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["app", "field"],
      properties: {
        app: {
          type: "string",
          pattern: APP_PATH,
        },
        field: { type: "string", pattern: APP_FIELD.source },
      },
    },
  ],
};

const SEQUENCE_HELP =
  "A step Termix runs on a host may be a sequence (1.4.10) instead of one command: sequence is a list of 1 to 20 items that one Run runs in order, as the person who pressed it, each shown on the step card with its own state, time, output and checks. Use it instead of chaining commands with && or ; and instead of sleep. Item types: " +
  '{"type":"run","label":"Deploy","command":"sudo paseo-deploy up media enforcarr"} (optional checks, captures, timeoutMs and interactive as for a step, and onFail "stop" (default) or "continue" for a read-only report after the main work); ' +
  '{"type":"delay","seconds":30,"reason":"let the service start"} (1 to 3600 seconds: a countdown on the page, run by Termix itself; the person may skip it); ' +
  '{"type":"wait","label":"Healthy","command":"curl -fsS https://127.0.0.1:8443/health","checks":[{"type":"contains","text":"ok"}],"within":180,"every":5} (runs the command until it exits 0 with every check passing: write it instead of a for or until loop with sleep; see WAIT ITEMS). ' +
  "Each run item is a new shell on its own connection: cd and variables do not carry over; set workdir on the step (an absolute path) and every run item starts there. A capture of an item fills {{name}} in later items and later steps (in a command or an event's text only with a value check that has matches on the item that captures it). An item that fails stops the sequence and fails the step, unless it says onFail continue; the person can then continue from that item, and the items that passed do not run again. " +
  "A sequence step has hostId and sequence, and no command, checks, captures, timeoutMs, interactive, stdin or secretCaptures of its own (put them on the run items), and cannot be an agent step or runIn terminal. get_runbook lists each run's items with their own output, exit code, checks and captures. See EVENTS for the waits built into Termix. " +
  "WAIT ITEMS: checks (at least one) say what ready looks like; stopIf (optional checks) fails the item at once when one matches, such as a job that reports FAILED; within (required, 1 to 7200 seconds) is the time limit for all attempts and delays together; attempts (1 to 500, default 500) the most attempts; timeoutMs the limit of one attempt. The schedule: every (seconds before the next attempt, default 5), backoff fixed (default: every each time), linear (every × n) or exponential (every × factor^(n-1), factor 1.1 to 10, default 2), maxDelay (cap on one delay, default 300, at most 3600) and jitter none (default), full or equal. A failed attempt means not yet; captures come from the attempt that passes only. " +
  'RETRY: a run item may have retry for a flaky command: {"attempts":5,"backoff":"exponential","every":2} (attempts 2 to 500 required; every, backoff, factor, maxDelay, jitter as for a wait; within optional, up to 7200; retryOn: a list of "exit", "check", "timeout", "connect", default all four: the failures that get another attempt). Not on an interactive item. ' +
  "Each attempt is a record inside its item: items[].attempts lists {attempt, status, startedAt, finishedAt, exitCode, stdout, stderr, checks, stopIf, why (exit, check, timeout, connect, stop-if, stopped, interrupted, or null when it passed)}, without output (stdout and stderr null): the item carries its last attempt's output, and get_attempt reads one attempt's (an earlier attempt keeps the last 4 KB of each stream). While one waits, the step has attempt {item, attempt, of, nextAt, endsBy}; schedules on the step lists each wait's planned attempts before Run. The server runs the attempts as the person who pressed Run, also with the page closed; the person who pressed Run, or a person who may connect to the host, may press Try now; anyone may press Stop. You get one event when the step ends, never one per attempt.";

const WAIT_EVENTS_HELP =
  "EVENTS (1.4.10): items that wait until a state holds, checked by Termix itself (no shell loop on the host), each with a wait's schedule: within (required, 1 to 7200 s), every, backoff, factor, maxDelay, jitter, attempts, timeoutMs (one check, default 30000), label, onFail. Use them instead of a wait item with docker inspect, systemctl, curl or test -f. " +
  '{"type":"container","name":"enforcarr","state":"healthy","within":180} (state healthy, running, exited or gone; one fixed docker container inspect, read by Termix; healthy and running fail at once when the container exits or restarts; healthy needs a HEALTHCHECK). ' +
  '{"type":"unit","name":"restic-backup.service","state":"finished","within":3600} (active, or finished: ran to its end with Result=success since the step started; fails at once when it failed; one fixed systemctl show). ' +
  '{"type":"http","url":"https://127.0.0.1:8443/health","servername":"termix.example.com","status":200,"contains":"ok","within":60} (a URL on 127.0.0.1, localhost or [::1] goes through the SSH connection to the host\'s own loopback; any other https URL goes from Termix itself, never to Termix\'s own loopback, its own addresses, 0.0.0.0 or a link-local address in any spelling; the certificate is always checked, against the URL\'s host name or servername (loopback only), with public roots plus the admin\'s extra CAs; plain http:// only to the loopback; redirects are not followed). ' +
  '{"type":"port","port":5432,"state":"open","within":60} (open or closed, on the host\'s own 127.0.0.1 (host may be localhost or ::1), through the SSH connection; fails at once when the host\'s SSH key does not allow forwarding). ' +
  '{"type":"file","path":"/srv/app/ready","state":"exists","within":300} (exists, nonEmpty or gone; SFTP stat as the SSH user, also on Windows; sudo true reads a root-only path with one fixed sudo -n stat, Linux only). ' +
  '{"type":"log","container":"enforcarr","pattern":"listening on","failPattern":"FATAL","within":120} (or unit instead of container, with sudo true to read the system journal with sudo -n; lines written after the step started; pattern and failPattern are JavaScript regular expressions up to 200 characters, with no repeated group that holds a repeat or alternatives, such as (a+)+ or (a|aa)+; a pattern that takes longer than 250 ms on the new lines fails the item). ' +
  '{"type":"job","command":"sudo restic-nightly.sh","unit":"restic-nightly","within":7200,"every":30} (starts the command as a transient root systemd unit with sudo -n systemd-run, streams its journal into the item, passes when it ended with Result=success; for work longer than the 10-minute limit of one command; Stop or running out of time stops the unit; the sleep ban applies to its command). ' +
  "container, unit, log and job (and file with sudo) need a Linux host: they are refused for a host list_hosts marks windows, and fail at once on a host whose SSH server is Windows. Names, paths and URLs may hold {{name}} values; patterns may not. Each item's command in get_runbook is what it checks (the fixed command, or the channel it opens); each check is an attempt with result, the state it read in words (healthy, exited (1), HTTP 503, port closed), visible also on a hidden step; why is not-yet (wait) or fail-state (failed at once).";

const NO_SLEEP_HELP =
  "Runbooks refuses a command that waits a fixed time: sleep in any spelling the shell reads as the word (also sleep -- 5, sleep${IFS}5, s''leep, in bash -c or time.sleep), Start-Sleep, timeout /t, read -t, timeout N around a command that never ends (tail -f, cat, read), or ping -n or -c to the host itself; values are read once filled in too. Make the step a sequence: put a delay item where a fixed wait was, and a wait item where a loop waited for something to be ready.";

const AGENT_STEP_HELP =
  'A step may be yours: owner "agent" (default "person"). The person sees "Waiting for the agent" on it and can only skip or reopen it; Termix never runs it. Its command, if any, only says what you will run (no hostId needed). When every earlier step ended (done, failed or skipped), do the work yourself, then call complete_step with outcome done or failed, a short note and the output you got; its checks (contains, notContains, matches, notMatches) test that output. An agent step cannot have captures, secretCaptures, stdin, a wait timer or exitCode checks. Use it for work you do between the person\'s steps, such as reading a dashboard or changing a file in a repository.';

const AMEND_HELP =
  'Amend a step in place instead of adding a fix at the end. kind "replace" makes a fixed version of a step that did not end done (pending, failed or skipped): the new step is 3a right after step 3, and step 3 shows "Replaced by 3a", keeps its runs and counts as ended. kind "substep" adds an extra step 3a (then 3b) after step 3 in any state. Later steps keep their numbers. An amendment can be amended too: replace 3a with 3b. reason (up to 500 characters) is shown on the new step. step has the fields of a new step and the same checks. Refused: a closed runbook (409), a step whose run is running (409 running), replace of a step that ended done (409 done: use substep) or was already replaced (409 replaced: amend its replacement). A later step names an amendment in stdin as "3a".';

const WHERE_HELP =
  'Where the person runs the command when it is not a shell on a Termix host, up to 80 characters: for example "Windows PC, PowerShell as admin" or "browser console on the admin page". A person step with command and where and no hostId shows "Run outside Termix: <where>", the command with its values filled in and a Copy button; Termix never runs it. The person pastes the output and marks the step done or failed; checks (not exitCode) and captures read the pasted output. Not with stdin or secretCaptures. Use it instead of a code block in body for a command that runs outside Termix. {{name}} values work in where too, as plain text.';

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

/** 1.4.11: the folder the person's list files the runbook under. */
const FOLDER_SCHEMA = {
  type: ["string", "null"],
  minLength: 1,
  maxLength: MAX_FOLDER,
  pattern: "^[^/]+$",
  description: `The folder the person's Runbooks list shows the runbook in: one level, 1 to ${MAX_FOLDER} characters (trimmed), no "/". Use your task's board name (gbtvg-coop, home-server, termix). The same folder in other letters keeps its existing spelling. Null: no folder. The person can move it.`,
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

/** The schedule of a wait item and of a run item's retry (phase 2). */
const SCHEDULE_PROPERTIES = {
  every: {
    type: "integer",
    minimum: SCHEDULE_LIMITS.everyMin,
    maximum: SCHEDULE_LIMITS.everyMax,
    description:
      "Seconds before the next attempt (the first delay). Default 5.",
  },
  backoff: {
    type: "string",
    enum: [...BACKOFFS],
    description:
      "How the delays grow: fixed (default, every each time), linear (every × n) or exponential (every × factor^(n-1)).",
  },
  factor: {
    type: "number",
    minimum: SCHEDULE_LIMITS.factorMin,
    maximum: SCHEDULE_LIMITS.factorMax,
    description: "exponential only: how much each delay grows. Default 2.",
  },
  maxDelay: {
    type: "integer",
    minimum: 1,
    maximum: SCHEDULE_LIMITS.maxDelayMax,
    description:
      "Seconds: the longest one delay may get, at least every. Default 300.",
  },
  jitter: {
    type: "string",
    enum: [...JITTERS],
    description:
      "none (default); full: a random delay from 0 to the delay; equal: half the delay plus a random part of the other half.",
  },
};

/** The fields of the events (1.4.10, phase 3); see EVENTS_HELP. */
const EVENT_PROPERTIES = {
  state: {
    type: "string",
    enum: [
      "open",
      "closed",
      "exists",
      "nonEmpty",
      "gone",
      "healthy",
      "running",
      "exited",
      "active",
      "finished",
    ],
    description:
      "port: open (default) or closed. file: exists (default), nonEmpty or gone. container (required): healthy, running, exited or gone. unit (required): active or finished.",
  },
  port: {
    type: "integer",
    minimum: 1,
    maximum: 65535,
    description: "port: the TCP port on the host's loopback.",
  },
  host: {
    type: "string",
    enum: [...LOOPBACK_HOSTS],
    description:
      "port: 127.0.0.1 (default), localhost or ::1. Never another address.",
  },
  url: {
    type: "string",
    maxLength: EVENT_LIMITS.url,
    description:
      "http: https://... (or http:// to the host's own 127.0.0.1, localhost or [::1]).",
  },
  status: {
    type: "integer",
    minimum: 100,
    maximum: 599,
    description: "http: the status it waits for, default 200.",
  },
  contains: {
    type: ["string", "null"],
    maxLength: EVENT_LIMITS.contains,
    description: "http: text the body must hold (the first 64 KB are read).",
  },
  servername: {
    type: ["string", "null"],
    description:
      "http, loopback https URL only: the host name the certificate must hold, such as termix.example.com.",
  },
  path: {
    type: "string",
    maxLength: EVENT_LIMITS.path,
    description: "file: an absolute path on the host.",
  },
  sudo: {
    type: "boolean",
    description:
      "file: read with sudo -n stat (Linux). log of a unit: read the journal with sudo -n journalctl.",
  },
  name: {
    type: "string",
    description:
      "container: a container name or id. unit: a systemd unit name.",
  },
  container: {
    type: ["string", "null"],
    description: "log: the container whose log to read.",
  },
  unit: {
    type: ["string", "null"],
    description:
      "log: the systemd unit whose journal to read. job: the transient unit's name (default runbooks-job-<run>-<item>).",
  },
  pattern: {
    type: "string",
    maxLength: EVENT_LIMITS.pattern,
    description: "log: a JavaScript regular expression a new line must match.",
  },
  failPattern: {
    type: ["string", "null"],
    maxLength: EVENT_LIMITS.pattern,
    description: "log: a new line that matches it fails the item at once.",
  },
};

const ITEM_SCHEMA = {
  type: "object",
  required: ["type"],
  description:
    'A sequence item: {"type":"run","command":...}, {"type":"wait","command":...,"checks":[...],"within":...}, {"type":"delay","seconds":...}, or an event (EVENTS): port, http, file, container, unit, log, job.',
  properties: {
    type: {
      type: "string",
      enum: ["run", "wait", "delay", ...EVENT_TYPES],
    },
    label: {
      type: ["string", "null"],
      maxLength: SEQUENCE_LIMITS.label,
      description: "Short name shown to the person.",
    },
    command: {
      type: "string",
      description:
        "run, wait, job: the shell command, in the step's workdir. {{name}} values work, also from earlier items' captures.",
    },
    checks: {
      type: "array",
      maxItems: 20,
      description:
        "run: checks on this item's output, as for a step. wait: at least one; the wait passes on the first attempt that exits 0 with every check passing.",
      items: CHECK_SCHEMA,
    },
    stopIf: {
      type: "array",
      maxItems: 20,
      description:
        "wait: checks on each attempt's output that, when one matches (passes), fail the item at once, such as a job that reports FAILED. Output checks only, no value checks.",
      items: CHECK_SCHEMA,
    },
    within: {
      type: "integer",
      minimum: 1,
      maximum: SCHEDULE_LIMITS.within,
      description:
        "wait and events (required): the most seconds for all attempts and delays together, up to 7200 (2 hours).",
    },
    attempts: {
      type: ["integer", "null"],
      minimum: 1,
      maximum: SCHEDULE_LIMITS.attempts,
      description: "wait: the most attempts, up to 500 (the default).",
    },
    ...SCHEDULE_PROPERTIES,
    retry: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["attempts"],
      description:
        'run: run the command again when it fails, for a flaky command, such as {"attempts":5,"backoff":"exponential","every":2}. Not on an interactive item.',
      properties: {
        attempts: {
          type: "integer",
          minimum: SCHEDULE_LIMITS.retryAttemptsMin,
          maximum: SCHEDULE_LIMITS.attempts,
          description: "The most attempts, the first one included: 2 to 500.",
        },
        within: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: SCHEDULE_LIMITS.within,
          description:
            "The most seconds for all attempts and delays; default 7200.",
        },
        retryOn: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: [...RETRY_ON] },
          description:
            "The failures that get another attempt: exit (non-zero exit code), check (a check failed), timeout, connect (no connection). Default all four.",
        },
        ...SCHEDULE_PROPERTIES,
      },
    },
    captures: {
      type: "array",
      description:
        "run, wait: values to take from this item's stdout, as for a step; the names are unique in the sequence. A wait takes them from the attempt that passes.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "pattern"],
        properties: {
          name: { type: "string", pattern: NAME.source },
          pattern: { type: "string" },
        },
      },
    },
    timeoutMs: {
      type: ["integer", "null"],
      minimum: 1000,
      maximum: 600000,
      description: "run: time limit for the command. Default 120000.",
    },
    onFail: {
      type: "string",
      enum: ["stop", "continue"],
      description:
        "run, wait: stop (default) ends the sequence and fails the step; continue records the failure and goes on.",
    },
    interactive: {
      type: "boolean",
      description:
        "run: open a terminal (pty) for this item, for prompts such as sudo's.",
    },
    seconds: {
      type: "integer",
      minimum: SEQUENCE_LIMITS.delayMin,
      maximum: SEQUENCE_LIMITS.delayMax,
      description: "delay: how long to wait, in seconds.",
    },
    reason: {
      type: ["string", "null"],
      maxLength: SEQUENCE_LIMITS.reason,
      description: "delay: why, shown with the countdown.",
    },
    ...EVENT_PROPERTIES,
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
      description: `Markdown shown before the command: why and what to check. ${TEXT_VALUES}`,
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
      description: `Shell command, run with the host's stored login. ${VALUE_SYNTAX} ${NO_SLEEP_HELP}`,
    },
    sequence: {
      type: ["array", "null"],
      minItems: 1,
      maxItems: SEQUENCE_LIMITS.items,
      description: SEQUENCE_HELP,
      items: ITEM_SCHEMA,
    },
    workdir: {
      type: ["string", "null"],
      maxLength: SEQUENCE_LIMITS.workdir,
      description:
        "An absolute folder on the host where the command, or each run item of a sequence, starts (1.4.10): Termix runs cd -- '<workdir>' && <command>, so leave the cd out of the command. For a POSIX shell (Linux, macOS); on a Windows host keep the cd in the command.",
    },
    expect: {
      type: "string",
      description:
        "Markdown: what the person should see when the step works. {{name}} values work here, as in body.",
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
          name: { type: "string", pattern: NAME.source },
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
    runIn: {
      type: ["string", "null"],
      enum: ["either", "terminal", "run", null],
      description:
        'How the person may start the command (1.4.6): "either" (the default: Run or Send to terminal), "terminal" (Send to terminal only, such as a sign-in that opens a browser or waits for typed input; Run is refused) or "run" (Run only; Send to terminal is refused). Only for a step with a host and a command; "terminal" cannot have stdin. Use it instead of writing "use Send to terminal" in the title or body.',
    },
    when: {
      type: ["object", "null"],
      description: `${WHEN_HELP}`,
    },
    vm: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["host", "name", "action"],
      description:
        "A VM step (1.4.7): the person presses one button (Start VM, Shut down VM, Restart VM, Show VM or Open console) and HAW VM Manager does the action on one VM, as that person, with HAW's roles and the host's own limits. Find hosts and VM names with list_vms. A VM step has no hostId, command, captures, stdin, timeoutMs or interactive, and cannot be an agent step. Its output is the VM's details as JSON and one summary line (\"build-1 is running, 192.0.2.10\"): checks (contains, notContains, matches, notMatches) and when output rules read it. With value, the step sets {{<value>.state}}, {{<value>.ip}} (the first IPv4 address, else the first; only when the VM has one), {{<value>.addresses}} (comma-separated) and {{<value>.id}} for later steps. The usual wait timer, order, when rule and repeat guard apply. Agents never act on VMs: a person presses the button.",
      properties: {
        host: {
          type: "integer",
          description:
            "A VM host from list_vms (a Termix host id this token may use).",
        },
        name: {
          type: "string",
          pattern: VM_NAME.source,
          description: "The VM's name, as list_vms shows it.",
        },
        action: { type: "string", enum: [...VM_ACTIONS] },
        force: {
          type: "boolean",
          description:
            "stop or restart only: turn off or hard reset instead of asking the guest. The card shows it in red and asks the person on its own; use it only when a shutdown cannot work.",
        },
        waitFor: {
          type: ["string", "null"],
          enum: [...VM_STATES, null],
          description:
            "Wait until the VM reaches this state, reading it every 2 seconds; the step fails at the time limit. Default: running for start and restart, off for stop, none for show. null: no wait. Not for console.",
        },
        waitSeconds: {
          type: "integer",
          minimum: 1,
          maximum: MAX_WAIT_SECONDS,
          description: "How long to wait for waitFor. Default 300.",
        },
        value: {
          type: ["string", "null"],
          pattern: NAME.source,
          maxLength: MAX_VM_VALUE,
          description:
            "Prefix of the values the step sets: build sets {{build.state}}, {{build.ip}}, {{build.addresses}}, {{build.id}}. Not for console.",
        },
      },
    },
    decision: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["options"],
      description:
        'A Decision step (1.4.6): the person chooses from these options with radio buttons (or check boxes with multiple: true) and presses Confirm; no free text, and only a person decides. Later steps read the choice in when: {"step":5,"chose":"rollback"}. The choice is a run of mode decision whose output is the chosen ids, one per line; value, when set, names a runbook value that holds the chosen ids joined with commas. A decision step has no host, command, checks, captures, stdin or wait timer. Use it for "only if needed" or "if the lead says so" instead of text.',
      properties: {
        options: {
          type: "array",
          minItems: 2,
          maxItems: 10,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "label"],
            properties: {
              id: { type: "string", pattern: OPTION_ID.source },
              label: { type: "string", maxLength: 120 },
              description: {
                type: ["string", "null"],
                maxLength: 1000,
                description: "Short Markdown under the label.",
              },
            },
          },
        },
        multiple: { type: "boolean" },
        min: { type: "integer", minimum: 1 },
        max: { type: "integer", minimum: 1 },
        value: { type: ["string", "null"], pattern: NAME.source },
      },
    },
    runInReason: {
      type: ["string", "null"],
      maxLength: 200,
      description:
        "One line the person sees next to the one button, such as 'it waits for you to sign in in the browser'. Needs runIn terminal or run.",
    },
    interactive: {
      type: "boolean",
      description:
        "Run opens a terminal (pty) for the command (1.4.6), so the person can type into programs that read one: sudo, ssh, ansible --ask-become-pass. Any Run without stdin already lets the person type into standard input (read, sudo -S); set this only for a program that needs a terminal. stdout and stderr then come as one stream: no check may read stderr. Cannot have stdin, secretCaptures or runIn terminal.",
    },
    generate: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["name"],
      description: `Make a secret (1.4.2). ${SECRET_STEPS_HELP}`,
      properties: {
        name: {
          type: "string",
          pattern: NAME.source,
          maxLength: MAX_SECRET_NAME,
        },
        format: {
          type: "string",
          enum: ["alnum", "hex", "base64url", "words", "pin"],
        },
        length: { type: "integer", minimum: 4, maximum: 128 },
        store: STORE_SCHEMA,
      },
    },
    ask: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["name", "label"],
      description:
        "Ask for a secret (1.4.2): a value the person types or pastes once, such as an API token another site shows. See generate.",
      properties: {
        name: {
          type: "string",
          pattern: NAME.source,
          maxLength: MAX_SECRET_NAME,
        },
        label: { type: "string", maxLength: 200 },
        pattern: { type: "string", maxLength: 300 },
        store: STORE_SCHEMA,
      },
    },
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
            pattern: NAME.source,
            maxLength: MAX_SECRET_NAME,
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
    name: "list_vms",
    description:
      "Read only (1.4.7): without host, the hosts of this token that HAW VM Manager manages, with the verbs each offers; with host, the VMs on that host (name, CPUs, memory, allowed by the host's name pattern, protected). Use it to write a VM step (vm in a step). The answer is a copy Runbooks read from HAW, as the person who saved this token's hosts, at readAt: it has no VM state, and a VM made later is in it only after a person saves the token's hosts again. An agent never acts on a VM.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "integer", description: "A hostId from list_vms." },
      },
    },
  },
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
    description: `List the runbooks made with tokens of this token's creator, newest change first, with progress (finished and total steps) and folder. ${OPEN_LINK}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["open", "done", "abandoned"],
          description: "Only runbooks with this status.",
        },
        folder: {
          type: ["string", "null"],
          maxLength: MAX_FOLDER,
          description:
            "Only runbooks in this folder (any spelling of it); null: only runbooks in no folder.",
        },
      },
    },
  },
  {
    name: "get_runbook",
    description: `Read one runbook: its steps in order with their status, the owner's notes, and every run of each step (newest first) with who ran it, when, the exact command, exit code, stdout and stderr (or pasted terminal output), and the result of each check ({label, ok, detail}). A sequence step (1.4.10) has sequence and workdir, and each of its runs has items: one record per item {position, type, label, command, seconds, reason, onFail, status (waiting, running, passed, failed, skipped), startedAt, finishedAt, plannedEndAt, exitCode, stdout, stderr, checks, captured, error, fromRunId (set on an item carried from an earlier run by Continue); a wait item or a run item with retry also has maxAttempts, endsBy, nextAttemptAt and attempts, one record per attempt}, and the run's own stdout and stderr are the items' output joined. You get one event when the step ends, not one per item or attempt. A step has schedules (the planned attempts of each wait or retried item) and attempt ({item, attempt, of, nextAt, endsBy} while one waits, else null). A run still in progress has running: true, the stdout and stderr that arrived so far, and lastOutputAt (when it last printed); read again to follow it. Output of steps the owner hid reads '[hidden by owner]'. A secret value reads [secret:<name>]; secrets lists each secret the steps capture, make or ask for into the runbook as {name, step, set, expiresAt}, and a run's stdin and secrets say where its input came from and which secrets it read or stored, by name only. Each step has a label (3, or 3a for an amendment), amendment ({kind, reason, by, stepId, stepLabel, oldCommand} or null) and replacedBy ({id, label} on a replaced step). Use it to see what happened after the owner ran steps. ${OPEN_LINK}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runbookId"],
      properties: { runbookId: ID("The runbook id.") },
    },
  },
  {
    name: "create_runbook",
    description: `Propose a new runbook. Steps are proposals: you never run them. The owner reads each step in Termix, sees the host and the exact resolved command, and runs it or skips it; the output is stored on the step. ${VALUE_SYNTAX} Prefer checks over only describing the expected output in expect. ${SEQUENCE_HELP} ${WAIT_EVENTS_HELP} ${NO_SLEEP_HELP} ${WAIT_HELP} ${STDIN_HELP} ${SECRETS_HELP} ${SECRET_STEPS_HELP} ${AGENT_STEP_HELP} Set owner so the person knows who to talk to. Returns the runbook as get_runbook does. ${OPEN_LINK} Give the person that link when you are done.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: {
        title: { type: "string" },
        owner: OWNER_SCHEMA,
        notify: NOTIFY_SCHEMA,
        folder: FOLDER_SCHEMA,
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
    description: `Change a runbook's title, summary, values, status (open, done, abandoned), owner, notify or folder. Values replace the whole author value set. A changed value changes the resolved commands, so the owner sees the new text before running. A folder works on any status and changes nothing else: send only folder to file a done or abandoned runbook without reopening it. ${OPEN_LINK}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runbookId"],
      properties: {
        runbookId: ID("The runbook id."),
        owner: OWNER_SCHEMA,
        notify: NOTIFY_SCHEMA,
        folder: FOLDER_SCHEMA,
        title: { type: "string" },
        summary: { type: "string" },
        values: { type: "object", additionalProperties: { type: "string" } },
        status: { type: "string", enum: ["open", "done", "abandoned"] },
      },
    },
  },
  {
    name: "add_steps",
    description: `Add steps to an open runbook, at the end or at a 1-based position. Steps cannot go before a step that already ran. ${VALUE_SYNTAX} ${SEQUENCE_HELP} ${WAIT_EVENTS_HELP} ${NO_SLEEP_HELP} ${CHECKS_HELP} ${WAIT_HELP} ${STDIN_HELP} ${SECRETS_HELP}`,
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
    description: `Change a step that has not run yet. A step that already ran is history and cannot change (error 409): amend it with amend_step instead, also to change its checks. Only the given fields change; checks and sequence replace the whole list (to make a one-command step a sequence, send sequence with command null). ${NO_SLEEP_HELP} ${CHECKS_HELP} ${WAIT_HELP}`,
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
    description: `${AMEND_HELP} Returns the runbook as get_runbook does. ${NO_SLEEP_HELP} ${CHECKS_HELP} ${STDIN_HELP}`,
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
  {
    name: "get_attempt",
    description:
      "Read one attempt of a wait or retried item, or one check of an event item, with its output. get_runbook lists each item's attempts without output (stdout and stderr null) and the item itself carries its last attempt's output; read an earlier attempt's output here. An earlier attempt keeps only the last 4 KB of each stream. On a step hidden from agents, its output reads '[hidden by owner]', as in get_runbook.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runbookId", "runId", "item", "attempt"],
      properties: {
        runbookId: ID("The runbook id."),
        runId: ID("The run's id (steps[].runs[].id)."),
        item: ID("The item's number in the sequence, from 1."),
        attempt: ID("The attempt's number, from 1."),
      },
    },
  },
];
