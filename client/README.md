# Weixin Agent Bridge Client

The Client is a remote execution node. It does not log in to Weixin. It runs
an AI Agent locally and registers itself with a Server using the Server address,
port, and secret.

## Configure and run

Requirements: Node.js 22+ and the local AI Agent CLI. The default executor is
`codex`; set `WEIXIN_CODEX_BIN` for another compatible Agent executable.

Required values:

```bash
export WEIXIN_SERVER_HOSTNAME=bridge.example.com
export WEIXIN_SERVER_PORT=8787
export WEIXIN_SERVER_SCHEME=https
export WEIXIN_SERVER_SECRET='copy-the-server-secret'
export WEIXIN_CLIENT_ID=server1
export WEIXIN_CLIENT_PUBLIC_URL=https://server1.example.com:8788
```

The Client listens on `WEIXIN_CLIENT_PORT` (default `8788`). It generates its
own node token in `WEIXIN_CLIENT_TOKEN_FILE` and sends that token to the
Server during registration. The Server uses it when forwarding execution
requests.

```bash
export WEIXIN_CLIENT_HOST=0.0.0.0
export WEIXIN_CLIENT_PORT=8788
export WEIXIN_CLIENT_LABEL='Cloud Server 1'
export WEIXIN_CODEX_CWD=/srv/project
export WEIXIN_CODEX_SANDBOX=workspace-write
export WEIXIN_CODEX_APPROVAL=never
node weixin-agent-bridge.mjs client
```

Alternatively, store the secret in a root-readable file and set:

```bash
export WEIXIN_SERVER_SECRET_FILE=/etc/weixin-agent-bridge/server.secret
```

The file should contain only the Server secret and have mode `0600`.

`WEIXIN_CLIENT_PUBLIC_URL` must be reachable from the Server. Use a private
network or HTTPS reverse proxy. Do not expose the Client without the generated
node token.

The Client sends a registration request immediately and a heartbeat every
`WEIXIN_CLIENT_HEARTBEAT_MS` milliseconds, default 30 seconds. The Server lists
the Client in `/agents` after registration.

Execution policy is local: remote requests cannot override
`WEIXIN_CODEX_CWD`, `WEIXIN_CODEX_MODEL`, `WEIXIN_CODEX_SANDBOX`,
`WEIXIN_CODEX_APPROVAL`, or `WEIXIN_CODEX_TIMEOUT_MS`. The public `/healthz`
response contains only `{ "ok": true }`; `/v1/metrics` requires the Client
node token.

## systemd

Edit `weixin-agent-bridge-client.service.example`, then install:

```bash
sudo cp weixin-agent-bridge-client.service.example /etc/systemd/system/weixin-agent-bridge-client.service
sudo systemctl daemon-reload
sudo systemctl enable --now weixin-agent-bridge-client.service
```
