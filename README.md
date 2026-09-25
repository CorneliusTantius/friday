# friday

A local web app with a general Friday chat and a separate [Pi](https://pi.dev) coding agent.

The Pi page starts one persistent Pi RPC session per browser tab from `~/.pi/workspace/`. Friday Chat is a separate, shared general conversation that runs from `~/.friday/workspace/` while its saved session transcripts stay under `~/.friday/data/` (override the root with `FRIDAY_HOME`, or the chat directory with `FRIDAY_CHAT_DIR`). The latest saved conversation resumes after server restarts. Existing conversations in the former `memory/sessions/` directory are copied during migration without deleting the originals. It has only the `bash`, `edit`, `read`, and `write` tools, with extensions and skills disabled. Those tools run with the Friday server user's permissions; the Friday workspace is their working directory, not a sandbox. The Pi page supports workspace selection, session browsing, session switching, and collapsible tool-call details. Separate tabs or clients can run independent sessions concurrently; switching away from a working session creates a separate runtime so the original continues. Pi-specific behavior stays behind its adapter so other device capabilities can be added later.

## Requirements

- Node.js 22.19+
- Pi installed and available as `pi` for the coding-agent page (Friday Chat can use the SDK without it when `FRIDAY_CHAT_DRIVER=sdk`)
- Provider authentication configured separately for the agent(s) you use

## Run

```bash
npm start
```

Open <http://127.0.0.1:3000>.

## Workspaces and sessions

The Pi agent defaults to `~/.pi/workspace/` (or `<PI_CODING_AGENT_DIR parent>/workspace/`) unless a workspace preference was saved; `FRIDAY_WORKSPACE` overrides that preference. Friday Chat runs from `~/.friday/workspace/` by default. The Friday Files sidebar browses `~/.friday/`, while Pi Files browses `~/.pi/`; neither changes the coding agent's working directory. Credential files and other secrets are not previewable. The workspace field autocompletes existing directories under `$HOME` and validates the final path. Relative paths such as `..` and an optional `cd ` prefix are supported when they stay inside `$HOME`. The selected workspace is persisted by Friday. The session picker lists saved Pi sessions for the selected workspace. Friday session transcripts are stored separately from the runtime workspace: each `.jsonl` file in `~/.friday/data/` is a conversation session. Choose **Open session** to continue one, or **New session** to start fresh.

## Development

```bash
npm run dev
```

## API

- `GET /` — web harness
- `GET /healthz` — server health
- `GET /api/status` — active workspace, model, and Pi state
- `GET /api/friday/status`, `GET /api/friday/history`, `POST /api/friday/chat` — independent general Friday conversation
- `GET /api/friday/models`, `POST /api/friday/model` — list and select Friday's model
- `GET /api/friday/thinking-levels`, `POST /api/friday/thinking-level` — list and select Friday's thinking level
- `POST /api/friday/events/token` — scoped SSE token for Friday Chat
- `POST /api/events/token` and `GET /api/events?token=...` — scoped real-time runtime events over SSE
- `GET /api/models` — available Pi models
- `POST /api/model` with `{ "provider": "...", "modelId": "..." }` — change the current model
- `GET /api/thinking-levels` and `POST /api/thinking-level` — read or change Pi's thinking level
- `GET /api/friday/files` and `GET /api/friday/files/content?path=...` — browse and preview non-secret files under `~/.friday/`
- `GET /api/pi/files` and `GET /api/pi/files/content?path=...` — browse and preview non-secret files under `~/.pi/` (the parent of `PI_CODING_AGENT_DIR` when overridden); Pi's coding workspace remains independently selected
- `GET /api/devices` — read-only Tailscale device status
- `GET /api/friday/settings`, `GET /api/pi/settings`, `GET /api/system/settings` — settings scoped to Friday Chat, coding Pi, and the server; Friday/System settings do not launch coding Pi
- `GET /api/system/github` — whether `gh` is installed and authenticated, without returning credentials
- `GET/POST /api/{friday|pi}/sync/settings` and `POST /api/{friday|pi}/sync/run` — configure separate GitHub targets and manually push private snapshots
- `GET /api/{friday|pi}/auth`, `POST /api/{friday|pi}/auth/login`, `GET/POST/DELETE /api/{friday|pi}/auth/flow`, `POST /api/{friday|pi}/auth/logout` — scoped provider authentication; accessible to devices permitted by your Tailscale ACLs
- `GET /api/settings` — legacy combined runtime and server configuration details
- `POST /api/settings/workspace` with `{ "workspace": "..." }` — persist the default workspace
- `GET /api/workspaces` — allowed workspace directories
- `GET /api/sessions?cwd=...` — saved sessions with running/working runtime indicators for a workspace
- `GET /api/history` — full current-session messages and tool calls; add `?limit=20` for a tail
- `POST /api/chat` with `{ "message": "..." }` — send a message
- `POST /api/session/reset` with `{ "cwd": "..." }` — start a new session
- `POST /api/session/select` with `{ "cwd": "...", "path": "..." }` — open a saved session
- `POST /api/session/rename` with `{ "cwd": "...", "path": "...", "name": "..." }` — rename a saved session
- `POST /api/session/delete` with `{ "cwd": "...", "path": "..." }` — delete a saved session; active sessions must be idle and not open on another device


## GitHub snapshots

Sign in with `gh auth login`, then enter an owner and repository name in Friday Settings or Pi Settings and choose **Sync now**. If the repository is missing, sync creates it as **private**; the authenticated GitHub account must have permission to create repositories under that owner. `gh` must be installed and authenticated on the Friday host. Sync verifies that each target is private before cloning and again before pushing; it never uses a token in a Git URL. Friday and Pi have separate targets, saved under `~/.friday/config/github-sync.json` and `~/.pi/agent/friday-sync.json`. Sync is manual, not scheduled, and updates only the `.friday/` or `.pi/` snapshot folder in the target repository.

Snapshots include settings, provider credentials, sessions, memory, hidden files, binaries, and other regular files. They exclude managed repositories, directories named `repos/` or `node_modules/`, `.git` metadata, and symlinks. This can push API keys, OAuth tokens, and sensitive conversation history: anyone with access to the private repository can read them. Use a private repository and review its access controls.

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

## Friday-owned storage

Friday stores app configuration at `~/.friday/config/config.json`; its SDK provider authentication and runtime settings belong separately in `~/.friday/config/auth.json` and `~/.friday/config/settings.json` (not Pi Agent's files). The SDK auth file is written with private permissions. Friday stores managed Git clones at `~/.friday/workspace/repos/`, Markdown notes at `~/.friday/workspace/notes/`, and chat session transcripts under `~/.friday/data/`. Pi repositories are under `~/.pi/workspace/repos/`; Pi credentials and session storage remain under `~/.pi/agent/`. Startup moves legacy repository and notes folders into the workspace layout, and updates the old default Pi workspace preference while preserving custom preferences.

`GET /api/repos` lists Friday-managed repositories and `POST /api/repos` with `{ "url": "https://..." }` clones one under `~/.friday/workspace/repos/`. `GET /api/pi/repos` and `POST /api/pi/repos` manage separate coding-agent clones under `~/.pi/workspace/repos/` (or `<PI_CODING_AGENT_DIR parent>/workspace/repos/`). `POST /api/repos/pull` and `POST /api/pi/repos/pull` with `{ "name": "repo" }` run `git pull --all` only when the working tree is clean. Repository cards show the current branch, working-tree change counts, upstream ahead/behind counts when available, and latest commit. Clone forms show an indeterminate progress bar and disable repeated submissions while Git works; each agent's repository store accepts one clone at a time. Pi credentials and sessions remain in `~/.pi/agent/`. `GET /api/notes` lists Markdown notes; `GET /api/notes/content?path=...` reads one inside the notes directory.

Friday Chat uses the isolated RPC runtime by default. Set `FRIDAY_CHAT_DRIVER=sdk` to opt into the separate Friday SDK runtime with the same `bash`, `edit`, `read`, and `write` tools, no extensions/skills/context files, and Friday-only auth/settings; verify your saved chat and streaming before making this your default. Friday and Pi Settings support separate OpenAI OAuth and API-key provider login through Pi's SDK. Provider credentials are kept in separate Friday/Pi auth files and are never returned to the browser. There is no app-level login: any device permitted by your Tailscale ACLs can manage both agents' provider credentials. For OpenAI subscription OAuth, choose **Browser login** or **Device code login** in Friday/Pi Settings. If signing in from another device, paste the redirect URL or authorization code into Friday’s sign-in form when requested; a callback to that device's `localhost` cannot reach the Friday host. Complete the provider authorization yourself. Automated tests cover the challenge flow but cannot authorize a real OpenAI account.
