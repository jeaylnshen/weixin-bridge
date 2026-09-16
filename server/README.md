# Weixin Agent Bridge Server

The Server is the only component that logs in to Weixin. It also runs a local
Agent and routes each Weixin user's messages to the selected local or remote
Client.

## Install

Requirements: Node.js 22+ and the local AI Agent CLI. The default executor is
`codex`, but another executable can be selected with `WEIXIN_CODEX_BIN` if it
accepts the same stdin prompt and writes a final answer to stdout or the
configured output file.

```bash
cd server
node --check weixin-agent-bridge.mjs
node weixin-agent-bridge.mjs login
```

## Configure and run

The Server chooses a port from `WEIXIN_SERVER_PORT`, default `8787`. If
`WEIXIN_SERVER_SECRET` is empty, a random 64-character secret is generated and
stored in `WEIXIN_SERVER_SECRET_FILE`.

```bash
export WEIXIN_SERVER_PORT=8787
export WEIXIN_SERVER_HOST=0.0.0.0
export WEIXIN_CODEX_CWD=/srv/project
export WEIXIN_CODEX_SANDBOX=workspace-write
export WEIXIN_CODEX_APPROVAL=never
node weixin-agent-bridge.mjs server
```

Read the generated secret file and transfer it securely to each Client. The
secret is intentionally not printed to logs. The Server HTTP API uses:

```text
GET  /healthz
GET  /v1/metrics
GET  /v1/clients
POST /v1/clients/register
POST /v1/clients/heartbeat
POST /v1/execute
```

All non-health endpoints require `Authorization: Bearer <server-secret>`.
The health response is limited to `{ "ok": true }`; metrics include execution,
latency, timeout, active-process, approval, and node counters.

Set `WEIXIN_ALLOWED_CLIENT_HOSTS=server1.example.com,server2.example.com` to
restrict registration to specific advertised hostnames. Client registration is
strictly validated, and heartbeats cannot alter registered endpoint metadata.

Remote requests cannot override the node's `WEIXIN_CODEX_CWD`, model, sandbox,
approval, or timeout settings.

### Optional upstream chaining

To make this Server register as a Client of another Server, set:

```bash
export WEIXIN_UPSTREAM_SERVER_HOSTNAME=parent.example.com
export WEIXIN_UPSTREAM_SERVER_PORT=8787
export WEIXIN_UPSTREAM_SERVER_SCHEME=https
export WEIXIN_UPSTREAM_SERVER_SECRET='parent-server-secret'
export WEIXIN_SERVER_NODE_ID=edge-server-1
export WEIXIN_SERVER_PUBLIC_URL=https://edge.example.com:8787
```

The Server keeps its own Weixin router and local Agent while also appearing in
the upstream Server's `/agents` list.

## Weixin commands

```text
/agents
/agent server1
/agent status
```

`/agents` includes the local Server executor and currently registered Clients.
Client entries disappear after the heartbeat TTL, configured by
`WEIXIN_CLIENT_TTL_MS` (default 90 seconds).

## systemd

Edit `weixin-agent-bridge-server.service.example`, then install:

```bash
sudo cp weixin-agent-bridge-server.service.example /etc/systemd/system/weixin-agent-bridge-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now weixin-agent-bridge-server.service
```

Put the generated secret in an `EnvironmentFile` or set
`WEIXIN_SERVER_SECRET_FILE`; do not commit it to source control.
