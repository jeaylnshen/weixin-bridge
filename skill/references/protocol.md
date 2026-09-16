# Agent Protocol Reference

All JSON requests use UTF-8 and `Content-Type: application/json`. Protected
requests use:

```text
Authorization: Bearer <secret>
```

## Server endpoints

```text
GET  /healthz
GET  /v1/metrics
GET  /v1/clients
POST /v1/clients/register
POST /v1/clients/heartbeat
POST /v1/execute
```

`/v1/clients/register` body:

```json
{
  "id": "server1",
  "label": "Cloud Server 1",
  "executeUrl": "https://server1.example/v1/execute",
  "clientToken": "client-node-secret",
  "agentType": "codex",
  "cwd": "/srv/project",
  "model": "",
  "timeoutMs": 120000
}
```

Heartbeat accepts the same body and updates `lastSeen`. The Server removes
clients older than `WEIXIN_CLIENT_TTL_MS`.

Registration validates identifiers, URL scheme/path, token length, metadata,
and timeout range. Set `WEIXIN_ALLOWED_CLIENT_HOSTS` to a comma-separated
hostname allowlist when registration must be restricted further. Heartbeats
only refresh an already registered record and cannot change its endpoint or
execution metadata.

## Execute endpoint

Request:

```json
{
  "prompt": "Task text",
  "images": [
    {"name": "image.png", "dataBase64": "..."}
  ],
  "files": [
    {"name": "report.txt", "dataBase64": "..."}
  ],
  "cwd": "/srv/project",
  "model": "",
  "sandbox": "workspace-write",
  "approval": "never",
  "timeoutMs": 120000
}
```

Response:

```json
{"text": "Final Agent response"}
```

Errors use:

```json
{"error": "description"}
```

An alternative Agent only needs to implement the execute endpoint and return
the same response shape. It may ignore options it does not support, but must
preserve authentication and avoid executing arbitrary requests without the
configured authorization policy.

The packaged executor always ignores remote execution-policy fields. Configure
its type with `WEIXIN_AGENT_TYPE` and local policy with `WEIXIN_AGENT_*` (or
the legacy `WEIXIN_CODEX_*` variables).
`GET /healthz` is public and returns only `{ "ok": true }`; authenticated
`GET /v1/metrics` returns operational counters.
