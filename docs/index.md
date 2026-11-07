# Runbooks

Runbooks lets an AI agent write a runbook for your servers and lets you run it, one approved command at a time. The agent proposes steps, each with a host and a command. You read every step in Termix, see the exact command and the host it runs on, and run it. The output is kept on the step, so nobody runs the same command twice by accident, and the agent reads the results back to plan what comes next.

The agent can never run anything. It only proposes and reads.

## Turn it on

1. Install the plugin and grant its capabilities. Termix lists them on install; [Security](security.md) says why each one is needed.
2. Give the people who run runbooks the **Use Runbooks** permission. Admins have it by default.
3. Give the people who make agent tokens the **Manage Runbooks tokens** permission. Admins have it by default.
4. Open **Runbooks** from the sidebar, press **Agent tokens**, and make a token for your agent. It is shown once: copy it into your agent's secret store.
5. Point the agent at the API or the MCP endpoint. See [Agent API and MCP](agent-api.md).

## Run a runbook

Open **Runbooks** from the sidebar. Open runbooks come first, with their progress and author.

A runbook shows its summary, its values and its steps in order. The next pending step has an orange border. Each step shows:

- what to do and why, written by the agent
- the host and the exact command, with every `{{value}}` already filled in, and a Copy button
- what you should see when it works
- its latest run (who, when, exit code, output) and any earlier runs
- a notes box, saved when you leave it; the agent can read it

### Run

**Run** shows the host and the exact command and asks you to confirm. The command then runs over SSH with the host's stored login. The step becomes Done on exit code 0 and Failed otherwise.

### Send to terminal

**Send to terminal** types the command into an open terminal to that host, without pressing Enter. Press Enter yourself, then paste the output into the box under the step and press **Mark done** or **Mark failed**. With no terminal open to that host, Runbooks offers to open one; press Send to terminal again once it is connected.

### Skip, reopen and hide

- **Skip** (or **Mark read** for a step with no command) records an optional reason.
- **Reopen** puts a step back to pending. Its runs stay in the history.
- **Hide output from agents** replaces the step's output, and values captured from it, with `[hidden by owner]` wherever an agent reads them. Use it for steps that print secrets.
- **Mark done** or **Abandon** at the top closes the runbook. Closed runbooks cannot run steps until reopened.

### When Termix asks again

- **Repeats.** A step that already ran, or a command that ran on the same host in the last 24 hours on any runbook, needs an explicit **Run again**. The question shows who ran it last, when, and the exit code.
- **Order.** A step that comes after a pending step needs **Run out of order**.
- **Changes.** If the agent changed the step or a value since you loaded the page, the run is refused and the page reloads, so you never run a command you did not see.
- **Missing values.** A step whose `{{value}}` has no value yet cannot run. It names the missing values.
- **Host keys.** **Run** refuses a host whose key Termix has not stored yet. Open a terminal to that host once, accept its key, and run the step again.

## Values

A command can use `{{name}}`. The value comes from the runbook's values: the ones the agent set, then values captured from earlier steps' output (a later capture wins). The values table at the top shows each value and where it came from. Values are pasted in as plain text, with no shell quoting.

## More

- [Agent API and MCP](agent-api.md): the endpoints, the MCP tools, and how to have an agent write runbooks
- [Security](security.md): what an agent can and cannot do, and the checks on every run
- [FAQ and limits](faq.md)
