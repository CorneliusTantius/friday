# friday

A small web harness for a local [Pi](https://pi.dev) coding agent.

The server starts one persistent Pi RPC session per browser tab. The plain UI supports workspace selection, session browsing, session switching, and collapsible tool-call details. Separate tabs or clients can run independent sessions concurrently; switching away from a working session creates a separate runtime so the original continues. Pi-specific behavior stays behind its adapter so other device capabilities can be added later.

## Requirements

- Node.js 20+
- Pi installed and available as `pi`
- Pi provider authentication configured

## Run

```bash
npm start
```

Open <http://127.0.0.1:3000>.

## Workspaces and sessions

Pi starts in the host home directory by default. Configure the allowed workspace roots before starting the server:

```bash
PI_CWD=/home/nelly \
FRIDAY_WORKSPACE_ROOTS=/home/nelly \
npm start
```

The workspace field autocompletes existing directories under the configured roots and validates the final path. Relative paths such as `..` and an optional `cd ` prefix are supported when they stay inside an allowed root. The session picker lists saved Pi sessions for the selected workspace. Choose **Open session** to continue one, or **New session** to start fresh.

The directory on disk is still `/home/nelly/Workspace/fridai`; the application/package name is now `friday`.

## Development

```bash
npm run dev
```

## API

- `GET /` — web harness
- `GET /healthz` — server health
- `GET /api/status` — active workspace, model, and Pi state
- `GET /api/models` — available Pi models
- `POST /api/model` with `{ "provider": "...", "modelId": "..." }` — change the current model
- `GET /api/thinking-levels` and `POST /api/thinking-level` — read or change Pi's thinking level
- `GET /api/files` and `GET /api/files/content` — browse and preview files inside the configured workspace root while keeping the active Pi workspace contextce
- `GET /api/devices` — read-only Tailscale device status
- `GET /api/settings` — safe runtime and server configuration details
- `POST /api/settings/workspace` with `{ "workspace": "..." }` — persist the default workspace
- `GET /api/workspaces`s` — allowed workspace directories
- `GET /api/sessions?cwd=...` — saved sessions with running/working runtime indicators for a workspace
- `GET /api/history` — current session messages and tool calls
- `POST /api/chat` with `{ "message": "..." }` — send a message
- `POST /api/session/reset` with `{ "cwd": "..." }` — start a new session
- `POST /api/session/select` with `{ "cwd": "...", "path": "..." }` — open a saved session

## Remote access with Tailscale

Tailscale is the recommended remote access path. Friday intentionally listens on localhost; Tailscale Serve publishes it privately to devices in your tailnet without router port forwarding.

On the workstation:

```bash
tailscale up
npm start
npm run tailscale:serve
tailscale serve status
```

Install Tailscale and sign in on your phone or other laptop, then open the HTTPS URL shown by `tailscale serve status`.

Useful commands:

```bash
npm run tailscale:status
npm run tailscale:reset
```

The `tailscale:serve` script targets the default port `3000`. If you change `PORT`, configure Serve manually:

```bash
tailscale serve --bg http://127.0.0.1:YOUR_PORT
```

Tailscale ACLs are the current access-control boundary. Do not bind this agent to `0.0.0.0` on an untrusted network; the chat endpoint can execute Pi tools in the configured workspace and currently has no application login.

For a temporary SSH alternative:

```bash
ssh -N -L 3000:127.0.0.1:3000 user@workstation
```
