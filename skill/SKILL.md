---
name: weixin-agent-bridge
description: Deploy, configure, troubleshoot, and extend the server/client Weixin Agent Bridge for routing messages to multiple AI agents.
---

# Weixin Agent Bridge

Use this skill when an AI Agent must deploy or operate the packaged Weixin bridge,
connect multiple cloud machines, or route a Weixin conversation to a named
remote Agent.

## Architecture

The Server is the only component that logs in to Weixin. It also executes tasks
locally and therefore acts as the `local` Agent. Each Client runs an Agent on a
cloud machine, registers to the Server, sends heartbeats, and exposes an
authenticated execution endpoint.

```text
Weixin -> Server -> local Agent or registered Client -> local AI Agent
```

The wire protocol is Agent-agnostic: an execution request contains a prompt and
optional base64 attachments; the response contains final `text`. Execution
directory, model, sandbox, approval, and timeout policy are fixed locally on
each node and cannot be overridden remotely. Select `codex`, `claude`, or
`opencode` explicitly with `WEIXIN_AGENT_TYPE`; if unset, the node probes in
that order. `WEIXIN_AGENT_BIN` requires an explicit type so a custom executable
cannot be misidentified.

## Deployment Rules

- Deploy exactly one Server for a Weixin account.
- Give every Client a unique `WEIXIN_CLIENT_ID`.
- The Server generates a secret on first start; copy it to Clients through a
  protected secret file or environment variable.
- Clients generate their own node token automatically. Do not reuse the Server
  secret as a Client token.
- `WEIXIN_CLIENT_PUBLIC_URL` must be reachable by the Server. Prefer private
  networking, VPN, or HTTPS reverse proxy.
- Do not expose `/v1/execute`, registration, or heartbeat endpoints without
  Bearer authentication.
- Use `WEIXIN_ALLOWED_CLIENT_HOSTS` on Internet-facing Servers to restrict
  which Client hostnames may register.
- Read operational counters from authenticated `GET /v1/metrics`; the public
  health endpoint intentionally exposes only `{ "ok": true }`.
- Use `workspace-write` only for explicitly authorized development tasks.

## Weixin Routing

Use these commands after the Server is running:

```text
/agents
/agent <client-id>
/agent status
```

Routing is per Weixin user. Approval records retain the selected Agent at task
creation time.

Local shortcut replies apply only while the selected Agent is `local`. Messages
for a remote Agent must always reach that Client. If a selected Client is
offline, stop and report it instead of silently executing on the Server.

## References

- Read [references/deployment.md](references/deployment.md) for deterministic
  Server and Client installation steps.
- Read [references/protocol.md](references/protocol.md) when implementing a
  non-Codex Agent or debugging registration and execution.

The sibling `server/` and `client/` directories in the release archive are
independent deployment packages. Deploy only the directory needed on each
machine.
