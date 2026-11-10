---
title: Agent notifications
order: 2
---

# Agent notifications

Runbooks can tell your agents when something happens in their runbooks: it is an agent's turn, a step failed, a runbook was closed, or a person pressed **Send to agent** on a step. It sends a signed HTTPS request (a webhook) to a receiver you run, which wakes the right agent session. Any receiver works: Runbooks only needs an https address.

Notifications are off until an admin turns them on. Without them, agents can still poll [`GET /agent/events`](agent-api.md#events).

## Set it up

In Termix, open **Settings**, **Plugins**, **Runbooks** (needs the Manage plugins permission):

1. Turn on **Notify agents**.
2. Enter the receiver's **Webhook address**. It must start with `https://`; `http` is refused.
3. If the receiver's certificate comes from your own CA, paste the CA in **CA certificate (PEM)**. Runbooks then trusts only that CA for it. Certificates are always checked.
4. Save.
5. Press **Make a new signing secret**. Copy the secret into your receiver: it is shown once, never again. A new secret replaces the old one at once.
6. Press **Test**. Runbooks sends a `test` event and shows the HTTP status your receiver answered.

Turning on notifications adds the `network:outbound` capability (to send the request) and `secrets:own` (to keep the signing secret sealed with Termix's installation key). The update to 1.4.0 asks the admin to agree to both.

## What is sent

For each event that a runbook's `notify` lists, Runbooks sends one request. The default list is `agent-turn`, `step-failed`, `runbook-done` and `sent`; an agent can add `step-done` and `amended` or leave types out (see [notify](agent-api.md#notify)). A `sent` event is always sent. Events from before notifications were turned on are not sent.

```
POST <your webhook address>
Content-Type: application/json
X-Runbooks-Event: 91
X-Runbooks-Signature: t=1762682820,v1=5f2c...e1
```

```json
{
  "id": 91,
  "type": "sent",
  "runbookId": 12,
  "stepId": 41,
  "stepPosition": 3,
  "stepLabel": "3",
  "owner": { "task": "T-42", "agent": "session:7f3a", "label": "Lead agent" },
  "openPath": "/?view=runbook&id=12",
  "at": "2026-11-09T10:07:00.000Z",
  "hasNote": true
}
```

| Field          | What it is                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | The event's id. The same on every retry: de-duplicate by it.                                                                                                     |
| `type`         | `agent-turn`, `step-failed`, `runbook-done`, `sent`, `step-done`, `amended`, or `test` (from the Test button)                                                    |
| `reason`       | Only on `step-failed` (`exit`, `check`, `stopped`, `interrupted`, `secret`, `manual`), `runbook-done` (`done`, `abandoned`) and `amended` (`replace`, `substep`) |
| `runbookId`    | The runbook. `null` on a test.                                                                                                                                   |
| `stepId`       | The step, or `null` for an event about the whole runbook                                                                                                         |
| `stepPosition` | The step's position, when there is a step                                                                                                                        |
| `stepLabel`    | The step's label, when there is a step: `"3"`, or `"3a"` for an amendment. On `amended`, the new step. The reason text is never in the request.                  |
| `owner`        | The runbook's `owner` as the agent set it: `task`, `agent` and `label`, each `null` when not set                                                                 |
| `openPath`     | The link to the runbook, relative to your Termix address                                                                                                         |
| `at`           | When the event happened                                                                                                                                          |
| `hasNote`      | `true` on a `sent` event that has a note. The note itself is not in the request.                                                                                 |

The request carries ids and labels only: **never output, never a command, never the text of a note**. A receiver that needs them reads them through the [agent API](agent-api.md) with the agent's token: `GET /agent/runbooks/{id}` has the steps, runs, outputs and the latest events with their notes, and `GET /agent/events?since=<id>` lists everything the token may see. That way the agent's token, not the webhook, decides what an agent can read, and output hidden from agents stays hidden.

A `test` event has `id` 0 and no runbook. Do not de-duplicate it.

## Check the signature

`X-Runbooks-Signature` is `t=<unix seconds>,v1=<hex>`, where `<hex>` is the HMAC-SHA256 of `<t>.<raw body>`, keyed with the signing secret as text. Check it on the raw body, before you parse it. Refuse a request whose `t` is more than 5 minutes away from your clock, and de-duplicate by `id`, so a captured request cannot be replayed.

A receiver in Node, with TLS:

<!-- prettier-ignore -->
```js
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
const secret = process.env.RUNBOOKS_SIGNING_SECRET, seen = new Set();
const tls = { key: fs.readFileSync("key.pem"), cert: fs.readFileSync("cert.pem") };

https.createServer(tls, (req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk)).on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers["x-runbooks-signature"] ?? "") ?? [];
    const mac = v1 && crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest();
    if (!mac || Math.abs(Date.now() / 1000 - t) > 300 || !crypto.timingSafeEqual(mac, Buffer.from(v1, "hex"))) return res.writeHead(401).end();
    const event = JSON.parse(raw);
    if (event.type === "test" || !seen.has(event.id)) { seen.add(event.id); wake(event); }
    res.writeHead(204).end();
  });
}).listen(8443);
```

`wake(event)` is yours: find the agent session by `event.owner.agent` (or `event.owner.task`) and tell it to read the runbook. Keep `seen` somewhere that survives a restart if your receiver restarts often.

## Delivery and retries

- Any 2xx answer means delivered. Runbooks does not read the answer's body.
- Anything else, no answer within 10 seconds, or a refused connection is tried again after 1, 5, 30 and 120 minutes. After the fifth attempt it is given up. The agent API still lists the event, with `deliveredAt: null`, so an agent can catch up with `GET /agent/events`.
- Redirects are refused. Answer the request where it is sent.
- Runbooks looks for due retries every 30 seconds. While notifications are off, nothing is sent, and retries wait.
- Requests go through Termix's outbound guard. A private address is allowed only for the webhook's own host.
- Answer quickly: do the work after you answer, not before.

## Send to agent

With notifications on, every step of a runbook that has an `owner` shows **Send to agent**. The person can add a note of up to 500 characters. Runbooks records a `sent` event (in the step's history, "Sent to the agent by ...") and delivers it whatever `notify` says. The request says `hasNote: true`; the agent reads the note in the runbook's `events`.
