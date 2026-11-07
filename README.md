<div align="center">

<h1>Runbooks</h1>

<p>Runbooks an AI agent proposes and a person runs, one approved command at a time, with every output kept</p>

</div>

<br />

## Overview

Runbooks is a [Termix](https://github.com/Termix-SSH/Termix) plugin for working on servers with an AI agent without handing it the keys. The agent writes a runbook through a token API or MCP: steps, each with a host, a command and what you should see. You read each step in Termix, see the exact command and host, and run it over SSH or send it to an open terminal. The output is stored on the step, so nobody runs the same command twice by accident, and the agent reads the results back to plan the next step.

The agent can never run anything.

Read the [docs](docs/index.md) to set it up and use it.

<br />

## Features

- Agents propose runbooks through a REST API or an MCP endpoint, with their own revocable tokens
- A person runs each step after a confirm that shows the host and the exact command
- Run over SSH with the host's stored login, or send to an open terminal and paste the output back
- Every run is kept with who ran it, when, the exit code and the output
- A repeat of a step, or of the same command on the same host within 24 hours, asks first
- `{{name}}` values, set by the agent or captured from earlier output
- Output hidden from agents, step by step
- Notes on every step that the agent can read

<br />

## Docs

- [Setup and use](docs/index.md)
- [Agent API and MCP](docs/agent-api.md), with curl examples, an MCP client config, and how to prompt an agent to write runbooks
- [Security](docs/security.md)
- [FAQ and limits](docs/faq.md)

<br />

## Requirements

Termix 26.11.0 or later (plugin API 1.13). Send to terminal needs the SSH Terminal plugin.

<br />

## Install

From the community registry, once listed: Plugins, Browse.

From a release file: an admin turns on developer mode and uses Plugins, Install from file with the `.tmxplug` from [Releases](https://github.com/Coolroo/termix-plugin-runbooks/releases). A file installed this way is unverified.

<br />

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run validate
npm run pack   # writes runbooks-<version>.tmxplug
```

`.npmrc` sets `legacy-peer-deps`, because npm 10 cannot resolve the SDK's optional peer set without it.

<br />

## Support

Found a bug or have an idea? Open an [issue](https://github.com/Coolroo/termix-plugin-runbooks/issues). This is a community plugin, looked after by its author, not the Termix team.

<br />

## License

Apache-2.0. See [LICENSE](LICENSE).
