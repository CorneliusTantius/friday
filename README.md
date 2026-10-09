# friday

A local web app with a general Friday chat and a separate [Pi](https://pi.dev) coding agent.

The Pi page starts one persistent Pi RPC session per browser tab with `~/.friday/workspace/` as its working directory by default. Pi's own configuration, credentials, and session transcripts remain under `~/.pi/agent/`. Friday Chat is a separate, shared general conversation that also runs from `~/.friday/workspace/` while its saved session transcripts stay under `~/.friday/data/` (override Friday's root with `FRIDAY_HOME`, or the chat directory with `FRIDAY_CHAT_DIR`). The latest saved conversation resumes after server restarts. Existing conversations in the former `memory/sessions/` directory are copied during migration without deleting the originals. Friday is an orchestrator and does not have general-purpose shell or file-editing tools. Its five Pi tools are `pi_sessions` (discriminated list/status/read), `pi_manage_session` (create/rename/delete/profile), `pi_send_prompt`, `pi_report_task`, and `pi_stop_run`. Existing-session actions require an explicit run ID; the server keeps separate current-user authorization and deletion-safety checks for create, rename, profile updates, delete, and stop. Friday can delete an inactive Pi conversation only when the current user explicitly requests that exact session by name or ID, or explicitly approves after a completed task; server-side checks reject the current Friday-linked session and any Pi session that is open, opening, active, or queued. This supports interactive Pi handoff while protecting live sessions. Extensions and skills are disabled. Coding Pi tools run with the Friday server user's permissions; workspaces are not sandboxes. The Pi page supports workspace selection, session browsing, session switching, and collapsible tool-call details. Friday has Pi conversations on its right sidebar (a drawer on smaller screens) and its own conversation sidebar supports creating, switching, renaming, and deleting sessions. Pi session titles are the staff names. Generated titles are suggestions in create/rename flows and are applied only after explicit user action; existing sessions are never renamed automatically. Legacy `displayName` and `repositories` values in the private run registry are retained when profiles are saved for compatibility, but are not displayed, exposed in session listings, or migrated to session titles. The visible-repositories checklist remains separate and accurately describes app-provided context, not a filesystem sandbox.

## Source layout

`src/server.js` remains the app entrypoint; `src/config.js` and `src/host-temperature.js` stay at the root for runtime setup and host monitoring. Feature modules are grouped shallowly: `src/pi/` contains Pi sessions, run state, routing, and policies; `src/friday/` contains Friday's SDK session, prompt, tools, and memory; `src/integrations/` contains Gmail, Slack, Calendar, GitHub sync, and provider auth; `src/storage/` contains file, finance, local-calendar, notes, and repository stores.

## Requirements

- Node.js 22.19+
- Pi installed and available as `pi` for the coding-agent page (Friday Chat uses the SDK and does not require the `pi` executable)
- Provider authentication configured separately for the agent(s) you use

## Run

```bash
npm start
```

Open <http://127.0.0.1:3000>.

## Workspaces and sessions

The coding Pi agent defaults to `~/.friday/workspace/` unless a workspace preference was saved; `FRIDAY_WORKSPACE` overrides that preference. Friday Chat also runs from `~/.friday/workspace/` by default. Pi's agent directory remains independent at `~/.pi/agent/` (or `PI_CODING_AGENT_DIR`), including Pi credentials and session transcripts; changing the working directory does not move Pi state or migrate old transcripts. Existing saved sessions remain under their original workspace grouping and can be opened by selecting that prior workspace. The Friday Files sidebar browses `~/.friday/`, while Pi Files browses `~/.pi/`; neither changes the coding agent's working directory. Hidden files and credential files can be viewed and edited through Files after app login; protect access to authenticated sessions because this includes secrets. JSON files are validated on save, and Markdown files show a rendered preview beside the editor. The workspace field autocompletes existing directories under `$HOME` and validates the final path. Relative paths such as `..` and an optional `cd ` prefix are supported when they stay inside `$HOME`. The selected workspace is persisted by Friday. The Pi session picker lists saved sessions for the selected workspace. Friday's left sidebar lists Friday conversations; its right sidebar lists Pi conversations and opens a selected session in the Pi page. Stable Pi run IDs and Friday-conversation links are stored privately under the Friday state directory. Obsidian-readable memory lives in `~/.friday/memory/`: curated `MEMORY.md` is supplied as context, while daily Markdown notes are marked **Needs review** and remain separate until you curate them. Use **Review memory** in Friday Chat to browse daily notes in Files. The Dashboard memory graph shows `[[wikilinks]]` between curated memory and the latest 40 daily notes without exposing note contents. Memory is excluded from GitHub snapshot sync by default; Friday conversation transcripts remain part of the sync snapshot. Friday Chat, Pi, and server settings are consolidated into collapsible groups under **System**. The restart control is available when Friday runs under its systemd unit and interrupts active work. Friday's default model and thinking level use the Pi settings schema in `~/.friday/config/settings.json`, for example: `{ "defaultProvider": "openai", "defaultModel": "gpt-4.1", "defaultThinkingLevel": "medium" }`. Choose a provider/model available in Friday's chat selectors; defaults take effect when Friday Chat initializes.

## Development

```bash
npm run dev
```

For user-requested Friday changes, validate and inspect the final diff, then commit to `main` and push to `origin/main` unless the user specifies another workflow. Preserve unrelated working-tree changes by default; when the user explicitly asks to integrate all current Friday changes, review and test them, include coherent changes, and exclude secrets, generated artifacts, and unreviewed broken work. Do not force-push, deploy, restart the service, or bypass review/authorization as part of this preference. This preference applies only to direct user requests; background review tasks and events do not authorize Git operations.

## API

- `GET /login`, `POST /api/login`, `POST /api/logout` — password login and session logout
- `GET /` — authenticated web harness
- `GET /healthz` — unauthenticated minimal health check
- `GET /api/status` — active workspace, model, and Pi state
- `GET /api/friday/status`, `GET /api/friday/history`, `POST /api/friday/chat` (queues and returns `202`), `POST /api/friday/chat/:id/cancel` (queued items only), `POST /api/friday/abort` — Friday conversation queue and interrupt control
- `GET /api/friday/sessions`, `POST /api/friday/sessions`, `POST /api/friday/sessions/:id/open`, `PATCH /api/friday/sessions/:id`, `DELETE /api/friday/sessions/:id` — list, create, open, rename, and delete Friday conversations
- `GET /api/friday/pi-conversations` — list Pi conversations with stable run IDs and runtime status
- `GET /api/friday/models`, `POST /api/friday/model` — list and select Friday's model
- `GET /api/friday/thinking-levels`, `POST /api/friday/thinking-level` — list and select Friday's thinking level
- `GET /api/models` — available Pi models
- `POST /api/model` with `{ "provider": "...", "modelId": "..." }` — change the current model
- `GET /api/thinking-levels` and `POST /api/thinking-level` — read or change Pi's thinking level
- `GET /api/friday/files` and `GET /api/friday/files/content?path=...` — browse and preview files under `~/.friday/`; `PUT /api/friday/files/content?path=...` saves safe JSON
- `GET /api/pi/files` and `GET /api/pi/files/content?path=...` — browse and preview files under `~/.pi/` (the parent of `PI_CODING_AGENT_DIR` when overridden); `PUT /api/pi/files/content?path=...` saves safe JSON; Pi's coding workspace remains independently selected
- `POST /api/system/restart` — authenticated restart request when Friday is running as a systemd service with automatic restart enabled

- `GET /api/devices` — read-only Tailscale device status
- `GET /api/friday/settings`, `GET /api/pi/settings`, `GET /api/system/settings` — settings scoped to Friday Chat, coding Pi, and the server; Friday/System settings do not launch coding Pi
- `GET /api/system/github` — whether `gh` is installed and authenticated, without returning credentials
- `GET /api/system/temperature` — authenticated, cached highest readable Linux thermal-sensor value in Celsius; reports unsupported/unavailable states and does not expose sensor identifiers or paths
- `GET/POST /api/friday/sync/settings` and `POST /api/friday/sync/run` — configure and manually run the single Friday private GitHub snapshot
- `GET /api/{friday|pi}/auth`, `POST /api/{friday|pi}/auth/login`, `GET/POST/DELETE /api/{friday|pi}/auth/flow`, `POST /api/{friday|pi}/auth/logout` — scoped provider authentication; accessible to devices permitted by your Tailscale ACLs
- `GET /api/socials/gmail/status`, `POST /api/socials/gmail/connect`, `GET /api/socials/gmail/callback`, `GET /api/socials/gmail/messages`, `POST /api/socials/gmail/disconnect` — authenticated Socials Gmail OAuth and on-demand Inbox metadata (OAuth callback is state/PKCE protected)
- `GET /api/calendar/events`, `POST /api/calendar/events`, `PUT /api/calendar/events/:id`, and `DELETE /api/calendar/events/:id` — authenticated local event agenda and CRUD
- `/api/socials/slack/*` — authenticated Slack status/connect/public-channel selection/disconnect; OAuth callback is browser-state protected
- `GET /api/settings` — legacy combined runtime and server configuration details
- `POST /api/settings/workspace` with `{ "workspace": "..." }` — persist the default workspace
- `GET /api/workspaces` — allowed workspace directories
- `GET /api/sessions?cwd=...` — saved sessions with stable server-managed run IDs and running/working runtime indicators for a workspace
- `GET /api/history` — full current-session messages and tool calls; add `?limit=20` for a tail
- `POST /api/chat` with `{ "message": "..." }` and `POST /api/abort` — send a message or stop the current Pi response
- `POST /api/session/reset` with `{ "cwd": "..." }` — start a new session
- `POST /api/session/select` with `{ "cwd": "...", "path": "..." }` — open a saved session
- `POST /api/session/rename` with `{ "cwd": "...", "path": "...", "name": "..." }` — rename a saved session
- `POST /api/session/delete` with `{ "cwd": "...", "path": "..." }` — delete a saved session; active sessions must be idle and not open on another device

Friday and Pi agent views use visibility-aware polling (2 seconds while busy, 15 seconds while idle); Friday's saved-session and Pi-session lists poll separately while visible. Agent SSE endpoints are not enabled.


## GitHub snapshots

Sign in with `gh auth login`, then enter an owner and repository name in the Friday sync section under **System**. Friday is the only GitHub snapshot sync: it covers `~/.friday/`, including the coding Pi's default working directory at `~/.friday/workspace/`. Saving a target starts a sync; the configured target is also synced at server startup and every local wall-clock quarter-hour (:00, :15, :30, or :45). **Sync now** remains available. If the repository is missing, sync creates it as **private**; `gh` must be installed and authenticated on the Friday host. Sync verifies privacy before cloning and pushing, and never uses a token in a Git URL. The target is saved under `~/.friday/config/github-sync.json`; only the `.friday/` snapshot folder is updated, and the local sync config is excluded. Local-only changes are pushed, remote-only changes are pulled, and distinct-path edits are merged. Same-path conflicts stop sync without overwriting either version. A legacy `~/.pi/agent/friday-sync.json` is left untouched but is no longer read or scheduled; Pi's own state is not part of Friday sync.

Snapshots include regular files, but exclude any file whose basename is exactly `auth.json`, managed repositories, directories named `repos/` or `node_modules/`, `memory/`, local calendar data under `data/calendar/`, `.git` metadata, and symlinks. An existing remote `auth.json` is not imported into the local Friday tree or overwritten by sync, and is not automatically removed from the remote repository or its Git history. Remove any exposed copy from GitHub yourself and rotate affected credentials. Other settings, credentials, and conversation history may still be included—anyone with repository access can read them. Review the private repository's access controls.

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

Friday requires a non-empty `FRIDAY_APP_PASSWORD` and refuses to start without it. Any non-empty value is accepted; choose a high-entropy password for remote access (for example, `openssl rand -base64 32`) and keep it private. For manual startup, export it before `npm start`. The systemd installer uses the repository’s ignored `.env` file when present (sets it to mode `0600` and requires a non-empty `FRIDAY_APP_PASSWORD`); otherwise it creates `~/.config/friday/app.env` with a random password. Retrieve the configured value locally when signing in. Login uses an HttpOnly, Secure, SameSite=Strict session cookie backed by server memory, and state-changing requests with an Origin header must match the request host. Restarting Friday signs out all clients. This is an additional gate, not a substitute for HTTPS and network access controls: the chat endpoints can execute host-side tools. Tailscale ACLs are still recommended; do not expose the server directly to an untrusted network.

For a temporary SSH alternative:

```bash
ssh -N -L 3000:127.0.0.1:3000 user@workstation
```

## Friday-owned storage

Friday stores app configuration at `~/.friday/config/config.json`; its SDK provider authentication and runtime settings belong separately in `~/.friday/config/auth.json` and `~/.friday/config/settings.json` (not Pi Agent's files). The SDK auth file is written with private permissions. Gmail OAuth requires a Google OAuth web client configured with the exact callback URI; set `FRIDAY_GMAIL_CLIENT_ID`, `FRIDAY_GMAIL_CLIENT_SECRET`, and `FRIDAY_GMAIL_REDIRECT_URI` in the Friday service environment (the systemd installer's `~/.config/friday/app.env` is outside GitHub sync). The redirect URI must be HTTPS for remote hosts, for example `https://<stable-tailnet-hostname>/api/socials/gmail/callback`; HTTP is accepted only for localhost development. Configure the same URI in Google Cloud. Socials requests only the restricted `gmail.metadata` scope, reads Inbox headers and unread status on demand, and does not store message history or send mail. The refresh token is stored in `~/.friday/data/socials/gmail/auth.json` with private file/directory permissions and is excluded from Friday snapshot sync by the `auth.json` rule. OAuth consent-screen configuration/testing and Google approval requirements depend on your account and deployment; real connection is unavailable until these host settings and credentials are supplied.

The Calendar page currently uses Friday's local event store; Google Calendar sync is not enabled. Events are stored at `~/.friday/data/calendar/events.json` with private directory/file permissions, atomic updates, bounded event counts and descriptions, UTC instants, and an IANA time-zone identifier. This local store is excluded from GitHub snapshots. Existing Google Calendar credentials under `~/.friday/data/socials/calendar/auth.json` are left untouched and are not read by the local calendar.

Slack read-only access uses a Slack OAuth app configured with `https://<stable-tailnet-hostname>/api/socials/slack/callback` and `FRIDAY_SLACK_CLIENT_ID`, `FRIDAY_SLACK_CLIENT_SECRET`, and `FRIDAY_SLACK_REDIRECT_URI`. Grant only the bot scopes `channels:read` and `channels:history`; Friday lists public channels for the connected workspace and reads history/threads only for channels selected in Socials. It cannot read DMs, search, or post; invite/install the Slack app in each public channel before reading its history. Tokens and channel-selection settings use private `auth.json` files under `~/.friday/data/socials/slack/` and `~/.friday/data/socials/slack-selection/`, both excluded by the snapshot rule. Provider content is fetched on demand without a content cache and is minimized/bounded; if used in Friday Chat it becomes part of the persistent chat transcript. Chat turns that read provider content are omitted from daily memory logs, but transcript retention still applies; enabled GitHub snapshot sync includes Friday chat transcripts, so excerpts may also reach that private repository. Disconnect removes local credentials/selections and attempts provider revocation where supported.

Slack OAuth callbacks must use the exact redirect URI registered with the provider; HTTPS is required except for localhost development. Configure Slack workspace installation/admin approval before rollout. Rate limits return sanitized retryable errors (Slack also returns `Retry-After`); no provider content is automatically retried or cached. Friday stores managed Git clones at `~/.friday/workspace/repos/`, Markdown notes at `~/.friday/workspace/notes/`, and chat session transcripts under `~/.friday/data/`; Obsidian-style memory is under `~/.friday/memory/`. Coding Pi runs with `~/.friday/workspace/` as its default `cwd`, while its credentials, settings, extensions, and session transcripts remain in `~/.pi/agent/`. Existing Pi-managed repository clone directories are left untouched and are no longer managed by Friday. On startup, Friday updates only a saved preference matching the former default Pi workspace (`~/.pi` or `~/.pi/workspace`) to `~/.friday/workspace/`; custom preferences and `FRIDAY_WORKSPACE` overrides are preserved. Changing this workspace preference moves no user data and does not relocate Pi credentials, session transcripts, or old clone directories.

`GET /api/repos` lists repositories in the shared Friday workspace, and `POST /api/repos` with `{ "url": "https://..." }` clones one under `~/.friday/workspace/repos/`. `POST /api/repos/pull` with `{ "name": "repo" }` runs `git pull --all` only when the working tree is clean. Repository cards show the current branch, working-tree change counts, upstream ahead/behind counts when available, and latest commit. Existing Pi-managed clone directories under `~/.pi/repos/` or `~/.pi/workspace/repos/` are left in place but are no longer listed, pulled, migrated, or deleted by Friday. Pi credentials and sessions remain in `~/.pi/agent/`. `GET /api/notes` lists Markdown notes; `GET /api/notes/content?path=...` reads one inside the notes directory.

Friday Chat runs through the Pi SDK in a separate Friday runtime with curated-memory context, no general-purpose host tools, no extensions or skills, and Friday-only auth/settings. Its five Pi tools use the coding agent's separate RPC runtime: `pi_sessions` lists sessions, profiles, workload, tasks, status, or bounded recent messages; `pi_manage_session` creates, renames, deletes, or updates a staff profile through action-specific server authorization; send, report, and stop remain separate. Every existing-session action requires an explicit run ID. Friday queues work only to the named run and returns without waiting. While this server process remains alive, a host queue-completion event routes the result to the exact originating Friday conversation, where a restricted reviewer checks the original objective before reporting completion or a blocker. Pi output is treated as untrusted evidence. Delegated task state and visible updates are persisted and included in `GET /api/friday/status`; staff expertise, responsibilities, capacity, and open-task workload are shown in the Friday sidebar. Session titles themselves are the staff names. Default per-session task capacity is two open tasks (queued, running, reviewing, or outcome-unknown); it limits assignment, not simultaneous execution, and Pi processes prompts serially within a session. Existing explicit capacities are preserved; legacy runs without a stored capacity use the default of two at read/assignment time, without rewriting existing profile records. Final task reports replace transient status details so completed/blocked rows do not retain in-progress text. If Friday restarts during queued/running/reviewing work, that work becomes outcome-unknown and consumes capacity; a review interrupted mid-flight is marked `interrupted` and requires exact-task manual review. Pi work is never automatically replayed. Task records expose review stage and timestamps; structured audit events are written to stdout without task content. On the systemd host, inspect them with `journalctl -u friday -o cat | grep '"component":"pi-task-lifecycle"'` and correlate by `taskId`/`runId`. A user may explicitly request manual exact-task inspection, but Friday must not resend the work and may be unable to correlate a missed result. The delete tool verifies the actual current user turn and refuses the current Friday-linked conversation and sessions open in Pi runtimes. Friday Chat itself does not launch the Pi CLI. Friday and Pi Settings support separate OpenAI OAuth and API-key provider login through Pi's SDK. Provider credentials are kept in separate Friday/Pi auth files and are never returned to the browser. The app password also gates provider credential management; any client with the password can manage both agents' provider credentials. For OpenAI subscription OAuth, choose **Browser login** or **Device code login** in Friday/Pi Settings. If signing in from another device, paste the redirect URL or authorization code into Friday’s sign-in form when requested; a callback to that device's `localhost` cannot reach the Friday host. Complete the provider authorization yourself. Automated tests cover the challenge flow but cannot authorize a real OpenAI account.
