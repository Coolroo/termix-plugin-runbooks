# Runbooks

Runbooks lets an AI agent write a runbook for your servers and lets you run it, one approved command at a time. The agent proposes steps, each with a host and a command. You read every step in Termix, see the exact command and the host it runs on, and run it. The output is kept on the step, so nobody runs the same command twice by accident, and the agent reads the results back to plan what comes next.

The agent can never run anything. It only proposes and reads.

## Turn it on

1. Install the plugin and grant its capabilities. Termix lists them on install; [Security](security.md) says why each one is needed.
2. Give the people who run runbooks the **Use Runbooks** permission. Admins have it by default.
3. Give the people who make agent tokens the **Manage Runbooks tokens** permission. Admins have it by default.
4. Open **Runbooks** from the sidebar, press **Agent tokens**, and make a token for your agent. Tick the hosts it may propose commands for. Only SSH hosts are listed: a remote desktop host (RDP, VNC, a console) cannot run a command. The token is shown once: copy it into your agent's secret store.
5. Point the agent at the API or the MCP endpoint. See [Agent API and MCP](agent-api.md).

## Run a runbook

Open **Runbooks** from the sidebar. Open runbooks come first, with their progress and author.

An agent can also give you a link to a runbook, like `https://<your Termix address>/?view=runbook&id=12`. It opens Termix with the Runbooks tab on that runbook, after you sign in if you were signed out.

A runbook shows its summary, its values and its steps in order. The next pending step has an orange border. Each step shows:

- what to do and why, written by the agent
- the host and the exact command, with every `{{value}}` already filled in, and a Copy button
- what you should see when it works, and the checks Runbooks tests on the output, if the agent set any
- its latest run (who, when, exit code, output) and any earlier runs
- a notes box, saved when you leave it; the agent can read it

### Run

**Run** shows the host and the exact command and asks you to confirm. The command then runs over SSH with the host's stored login. The step becomes Done on exit code 0 and Failed otherwise.

You do not wait for it. While the command runs, the step shows:

- its output as it arrives, standard output and standard error apart. The box follows the newest line; scroll up to read and it stays where you put it.
- **Running for m:ss**, the time since it started.
- **No output for Ns**, the time since it last printed anything. It turns to a warning after 30 seconds: the command may be stuck, or just quiet. See [FAQ](faq.md#how-do-i-see-if-a-command-stalled).
- **Stop**, which asks first, then ends the command. Runbooks sends it a TERM signal where the server accepts one and closes its session. The run is kept as Failed, "stopped by" you, with the output so far.

The page reads the output every second while a command of the runbook runs, and every 5 seconds otherwise. A step cannot be run again while it runs. When it ends, a message says how, and the step's status and captured values update.

If Termix restarts while a command runs, the run is kept as Failed with "interrupted: Termix restarted while it ran" and the output that had arrived (Runbooks saves it every 2 seconds). The command may still have finished on the host: check before you run it again.

### Checks

An agent can add checks to a step: rules such as "exit code is 0", "the output contains `active (running)`" or "the captured version matches `^1.2`". They are listed under **You should see**, and in the Run confirm, with an empty circle until the step runs. When the run ends, each gets a tick or a cross and a short reason, such as "expected stdout to contain 'active (running)'".

If any check fails, the step is Failed even when the command exited 0, and a red box under it lists the checks that failed. Read the output, then **Run** again or **Reopen** the step. Values captured by a run whose checks failed are not kept. For a step sent to a terminal, the checks are tested on the output you paste when you press **Mark done**; enter the exit code in the box next to it if a check needs one. **Mark failed** tests nothing.

### Wait timers

A step can ask you to wait after the step before it ended, for example two minutes after a restart. Until the step before it has ended, the step says "Waits 2 min after step 3". Once it has ended, the step counts down, "Wait 1:42 before you start", with the agent's reason, and **Run** and **Send to terminal** look greyed out. They still work: before the end they ask "Start anyway?", and a start before the end is recorded in the audit log. At zero the step says "You can start now".

The timer starts when the step before it last ended: its run finished, or you marked it done or skipped it. Reopening that step stops the timer until it ends again.

### Send to terminal

**Send to terminal** types the command into a terminal to that host in one click, without pressing Enter, and brings that terminal to the front. Press Enter yourself, then paste the output into the box under the step and press **Mark done** or **Mark failed**.

It uses a connected terminal to the host when one is open, the one on screen first. With none open, it opens one, waits for it to connect (up to 30 seconds), and then types the command. If the terminal does not connect in time, nothing is recorded: copy the command instead. The only questions it asks are the repeat and order questions below.

### Skip, reopen and hide

- **Skip** (or **Mark read** for a step with no command) records an optional reason.
- **Reopen** puts a step back to pending. Its runs stay in the history.
- **Hide output from agents** replaces the step's output, and values captured from it, with `[hidden by owner]` wherever an agent reads them. Use it for steps that print secrets.
- **Mark done** or **Abandon** at the top closes the runbook. Closed runbooks cannot run steps until reopened.

### When Termix asks again

- **Repeats.** A step that already ran, or a command that ran on the same host in the last 24 hours on any runbook, needs an explicit **Run again**. The question shows who ran it last, when, and the exit code.
- **Order.** A step that comes after a pending step needs **Run out of order**.
- **Wait.** A step whose wait timer has not ended needs **Start anyway**.
- **Changes.** If the agent changed the step or a value since you loaded the page, the run is refused and the page reloads, so you never run a command you did not see.
- **Missing values.** A step whose `{{value}}` has no value yet cannot run. It names the missing values.
- **Host keys.** **Run** refuses a host whose key Termix has not stored yet. Open a terminal to that host once, accept its key, and run the step again.
- **SSH only.** Run and Send to terminal refuse a host that does not take SSH, such as a remote desktop host.

## Values

A command can use `{{name}}`. The value comes from the runbook's values: the ones the agent set, then values captured from earlier steps' output (a later capture wins). The values table at the top shows each value and where it came from. Values are pasted in as plain text, with no shell quoting.

## More

- [Agent API and MCP](agent-api.md): the endpoints, the MCP tools, and how to have an agent write runbooks
- [Security](security.md): what an agent can and cannot do, and the checks on every run
- [FAQ and limits](faq.md)
