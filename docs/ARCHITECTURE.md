# Architecture

> To install, see [INSTALL.md](../INSTALL.md). For a quick overview, see the [README](../README.md) - this file documents how each part works internally, in depth.

Admin dashboard for a home-lab mini server running on a Raspberry Pi, with no heavy dependencies (no Grafana/Prometheus/InfluxDB - just the dashboard's own SQLite). It's a single-page SPA (`index.html` + the native ES modules in `web/src/` - no JS framework/bundler, the JS that runs in the browser is always plain; the only build step is compiling the CSS via Tailwind, see [Styling (Tailwind)](#styling-tailwind)) with six screens swapped by hash route (`#overview`/`#docker`/`#tasks`/`#status`/`#internet`/`#settings`, no reload, no new tab). The on-screen labels are in Portuguese (the UI itself wasn't translated - only this documentation and the code comments were): **Visão Geral**/Overview (read-only - CPU/RAM/temperature/uptime/traffic/internet cards, the first three plus the internet card clickable/linked to see more), **Docker** (containers + docker-compose projects + backups), **Tarefas**/Tasks (the dashboard's own scheduler), **Status** (monitoring of external URLs/services - see [Status (Uptime)](#status-uptime)), **Internet** (deep-dive on the connectivity check behind the Overview card - see [Internet connectivity](#internet-connectivity)), and **Configurações**/Settings (Overview cards, login, Telegram notifications). Protected by login (its own screen, persistent session) - see [Authentication](#authentication).

## Architecture

```
Browser
  ↓ :8080
pi-dashboard-web  (nginx, static + proxy /api → api:3000)
  ↓ internal docker network (not published on the host)
pi-dashboard-api  (Node.js + Express)
  ├── /host/proc, /host/sys, /host/rootfs, /host/mnt/touro, /host/etc  (read-only bind mounts)
  └── /var/run/docker.sock (read-write bind mount)
```

- Only the **web** container publishes a port on the host (8080). The API isn't directly reachable from outside.
- Every host filesystem bind mount (`/proc`, `/sys`, `/`, `/mnt/touro`, `/etc/*`) is `read-only` - used only for metrics.
- The Overview screen only makes read calls to the Docker Engine (`listContainers`, `inspect`, `stats`). The Docker screen (side nav, no page leave) calls `start`/`stop`/`pause`/`unpause`/`restart`/`recreate`/`remove`, live-tails logs, and reads full `inspect` - for that, `docker.sock` is mounted **read-write**. See [Container management](#container-management-docker-screen) below.
- The same screen also runs `docker compose pull`/`up -d`/`down` and reads/edits the `docker-compose.yml` of a set of external projects (today: `cloudflared`, `cpuminer-opt`, but more can be registered from the UI itself), via CLI (`docker-cli-compose`, installed in the API image). Each registered project is mounted individually into the API container, `:ro` for the whole directory plus a second, more specific `:rw` bind mount just for the compose file itself - so the `.yml` can be edited/saved without the container having write access to the rest of the project (source code, `.env`, etc). See [docker-compose management](#docker-compose-management) below.
- The Tasks screen schedules actions the API already knows how to do (update a project, prune images, run a backup) - it never touches the host's crontab/systemd. Persisted on a named Docker volume (`pi-dashboard-data:/data`), not a bind mount, since it's pure internal application state with no relation to a specific host path. See [Tasks](#tasks-scheduler) below.
- Project backups (the `data/` directory, when it exists) go to `/mnt/touro/backups/<project>/` - only that subfolder of the drive is `read-write`, the rest of `/mnt/touro` stays `:ro` (metrics). See [Backups](#backups) below.
- Both containers run as a non-root user (`node` uid 1000 on the api, `nginx` uid 101 on the web) with a `read_only: true` root filesystem - this doesn't limit Docker actions, which go through the socket, not the container's filesystem.
- **Login with its own screen and a persistent session** (SQLite) in front of every `/api/*` route (see [Authentication](#authentication)). This is the only barrier: whoever has the password can stop/recreate any container on the host, read/edit the `docker-compose.yml` of the mounted projects (which already contain plaintext secrets, e.g. the `cloudflared` tunnel token), register new projects, and schedule/run tasks. Still assumes a trusted internal network behind the login - don't expose this to the internet.
- **Its own SQLite database** (`api/src/lib/db.js`, `better-sqlite3`) on the same named volume used by the scheduler - holds jobs/history and login sessions today, meant as the general place for anything the application needs to persist going forward. See [Database (SQLite)](#database-sqlite) below.
- **`pid: host`** - the API container shares the host's PID namespace. It's the only way to read the Pi's *real* network traffic: `/proc/net/*` is resolved by the network namespace of whoever is reading it, not where the mount came from, so even with all of `/proc` mounted, without this you'd only ever see the container's own tiny internal veth traffic. Costs visibility (not control) into every host process's name/resource usage - see [Processes and traffic (Overview)](#processes-and-traffic-overview) below.
- **Notifications (Telegram)** - bot token and chat IDs per event type, encrypted at rest (`AES-256-GCM`, key in `APP_ENCRYPTION_KEY`) and never redisplayed to the browser once saved. No new mount (just outbound HTTPS calls to `api.telegram.org`). See [Notifications](#notifications-telegram) below.

## Starting the dashboard

First install on a new host: see [INSTALL.md](../INSTALL.md). A host that's already fully configured
(`.env`, `docker-compose.override.yml`) and just needs the containers (re)started:

```bash
cd pi-dashboard   # the directory where you cloned/copied the project
docker compose up -d --build
```

Open: **http://PI_IP:8080**

## Stopping the dashboard

```bash
docker compose down
```

## Configuration

`.env` file:

```
DOCKER_GID=986
```

The gid of the `docker` group on the host, needed for the API's non-root user to read `/var/run/docker.sock`. If the gid is different on another host, check with `getent group docker` and adjust `.env`.

`BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` also live in `.env`, but only matter for seeding the login on first boot - after that the password is changed from the Settings screen, not by editing `.env`. See [Authentication](#authentication).

`APP_ENCRYPTION_KEY` (`.env`) is the key used to encrypt the Telegram bot token and the chat IDs configured in Notifications at rest - only needed if you're going to use that screen. Generate with `openssl rand -hex 32` and **never change it** once notifications are configured: changing it makes everything already saved permanently unreadable (no recovery). See [Notifications](#notifications-telegram).

The registry of compose-manageable projects lives in **`docker-compose.override.yml`** (not in `docker-compose.yml`, not in `.env`) - a separate file that `docker compose` loads automatically alongside the main one (standard Compose convention, no `-f` needed). Unlike the rest of the project, this file isn't meant to be hand-edited: it's generated entirely by the "docker-compose management" screen (the "Register project" form) every time a project is added or removed - see [Registering a new project via the UI](#registering-a-new-project-via-the-ui) below. If you do need to edit it by hand, the format is:

```yaml
services:
  pi-dashboard-api:
    environment:
      COMPOSE_PROJECTS: name=/absolute/path,other-name=/other/path
    volumes:
      - /absolute/path:/absolute/path:ro
      - /absolute/path/docker-compose.yml:/absolute/path/docker-compose.yml
```

(same rule as always: source == destination on the mount, one pair of lines per project). After editing by hand or registering via the UI, you need `docker compose up -d --build` to apply it - this container can't mount a new path into itself without being recreated.

## Frontend (SPA)

`index.html` only holds the app shell now (sidebar, the two auth screens, and a bare `<pd-view-overview>`/`<pd-view-docker>`/`<pd-view-tasks>`/`<pd-view-status>`/`<pd-view-internet>`/`<pd-view-settings>` tag per screen); `core/router.js` decides which one is visible based on the URL hash, toggling the same `.hidden` class it always did. No bundler, no framework - native browser ES Modules (`<script type="module" src="src/app.js">`, see [Authentication](#authentication) for when this is injected) plus native Custom Elements: each screen has its own folder under `views/` (`<name>/view.js` for the logic, `<name>/template.html` for its markup - real HTML, not a JS string; that markup used to be static HTML in `index.html`), and `view.js` calls `defineView()` (a small `core/dom.js` helper around `customElements.define()`), passing it a `TEMPLATE_URL` built from `import.meta.url` so the fetch below resolves next to that view's own file regardless of the page's URL. `defineView()`'s `connectedCallback` is async: it `fetch()`es that view's `template.html`, sets it as the tag's `innerHTML` - already sitting in `index.html` - then wires up that screen's own listeners/polling (no library needed for this, browsers have no built-in way to `import` a plain `.html` file as text without a bundler, so a small fetch is the whole mechanism; see `web/nginx.conf`'s no-cache rule for `src/views/**/*.html` and `input.css`'s `@source "./views/**/*.html"` for the two places that had to learn about the new file type). Since screens no longer necessarily finish mounting in import order (each one's fetch resolves independently, on its own schedule), the few places that reach across screens no longer assume one is ready before another: `views/settings/view.js`'s card-visibility toggles query `views/overview/view.js`'s card grid, so it re-applies once on the first `pd-system-update` event (dispatched only once Overview has actually rendered) instead of assuming the grid exists at its own mount time; `views/docker/view.js` calls `views/tasks/view.js`'s `refreshJobProjectOptions()`, which now guards against `#job-project` not existing yet (Tasks calls it again itself once its own template is in, self-healing either ordering). Deliberately light DOM (no shadow root): the compiled Tailwind CSS is one global stylesheet, and every id/class is still reached the exact same way as before (`document.getElementById`, cross-view listeners) - only the ES module graph and the source of each screen's markup changed, not the DOM APIs used against it. `src/app.js` is just the entry point, which imports `core/router.js` plus one `view.js` per screen (each one owning only that screen's logic, with `export`/`import` for the little that needs to be shared between them - e.g. `views/docker/view.js` and `views/tasks/view.js` share the list of compose-manageable projects; `views/internet/view.js` stays live off `views/overview/view.js`'s own 2s `/api/system` poll via a `pd-system-update` window event instead of polling that endpoint a second time - see [Internet connectivity](#internet-connectivity)). Genuinely generic helpers (number/byte formatting, `actionButton`, the action-result banner, sparkline drawing/resampling, `defineView`, the shared uptime/internet checks-bar renderer) live in `core/format.js`/`core/dom.js`/`core/charts.js`.

- `#overview` (or an empty hash) → Overview.
- `#docker` → Docker.
- `#tasks` → Tasks.
- `#status` → Status (monitoring of external URLs/services - see [Status (Uptime)](#status-uptime)).
- `#settings` → Settings.
- any other hash (e.g. `#project-cloudflared`, used by the project sidebar links) doesn't switch screens on its own - it only switches to Docker if it starts with `project-`, and otherwise lets the browser scroll to the element with that id normally (a plain anchor).

No navigation ever leaves the page: sidebar links are `<a href="#...">`, so the browser never makes a new page request or opens a tab. Screens keep updating in the background (Overview every 2s, Docker every 5s, Tasks and Status every 15s) regardless of which one is currently visible - switching screens is just showing/hiding what's already loaded, not fetching anything new. The success/error banner for any action (`#action-banner`/`#action-ok`) is shared across all of them, not duplicated per screen.

**Sidebar on mobile**: on screens up to 860px wide, the sidebar becomes an off-canvas drawer instead of always being visible - opens with the hamburger button that appears at the top (`#sidebar-open-btn`), closes by clicking the dimmed backdrop, the "×" inside the drawer itself, or automatically when navigating to any screen (`hashchange`, `web/src/core/router.js`). Uses no UI library - it's just `translate-x` + `position: fixed` via the `.open` class, see `.sidebar`/`.sidebar-backdrop` in `web/src/input.css`.

## Styling (Tailwind)

All the CSS is generated by [Tailwind](https://tailwindcss.com/) (v4) from `web/src/input.css` - there's no hand-written CSS left in the project. `web/style.css` (the file `index.html` loads, and that `web/Dockerfile` copies into the image) is **generated**, not hand-edited - editing it directly is wasted effort, the next build overwrites it.

**How the class vocabulary was preserved**: the modules under `web/src/` (`core/`/`views/`) and `auth.js` build class names dynamically all the time (`` `state-badge ${ok ? 'state-running' : 'state-exited'}` ``, `'btn btn-start'`, `'card card--cpu card--clickable'`, etc.) - hundreds of references scattered through the code. Rewriting all of that to use Tailwind utility classes directly would be a project of its own (risky without being able to see the result visually). The migration kept the **exact same class names as always** (`.btn`, `.card`, `.panel`, `.state-badge`, `.switch`, `.data-table`, etc.), just now defined in `input.css` inside `@layer components` using `@apply` (e.g.: `.btn { @apply border border-line bg-surface-raised ...; }`) - the HTML/JS didn't change on that front, only what generates the CSS behind each class. New structural layout (the mobile sidebar drawer, the Overview cards grid) uses Tailwind utilities directly in `index.html`/inside `@media` in `input.css`, with no need to keep a fixed name there.

**Design tokens** (`@theme` in `input.css`): the same dark palette as always (background, text, state colors) became Tailwind `--color-*`/`--radius-*` variables - defining `--color-brand: #4f9cf9`, for example, already gives you the `bg-brand`/`text-brand`/`border-brand` classes for free. The names deliberately avoid Tailwind's default palette (`red`/`green`/`gray`/`cyan`...) to not collide with it - hence `--color-ok`/`--color-danger`/`--color-neutral`/`--color-net` instead of `--color-green`/`--color-red`/etc.

**Build**: `web/Dockerfile` is multi-stage - a first `node:20-alpine` stage runs `npm ci` + `npx tailwindcss` and produces `style.css`, the final stage (nginx) just copies that result, with no Node at all in the image that actually runs. `docker compose up -d --build` alone is enough - there's no manual step left to forget, and no risk of stale CSS without any warning (that used to be a documented limitation here; the multi-stage build eliminated the problem instead of just documenting the caveat).

To iterate on CSS locally without rebuilding the whole image on every change (faster to see the result):

```bash
cd web
npm install       # only the first time, or when package.json changes
npx tailwindcss -i ./src/input.css -o ./style.css --minify --watch
```

`web/package.json`/`package-lock.json`/`node_modules` exist only for this local dev workflow - the real production build happens inside `docker build` itself (the `css-build` stage of the Dockerfile), regardless of whether this was run on the machine that built the image or not.

## Authentication

A real login screen (no longer the browser's native basic-auth popup). A single username/password - stored (hashed, not plaintext) in the SQLite `auth_config` table (see [Database (SQLite)](#database-sqlite)), no longer read straight from `.env` on every login attempt.

`BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` in `.env` are just a shortcut for unattended/scripted installs (see below) - the normal thing is to leave them blank and configure it from the screen itself.

How it works:

- `index.html` loads only `auth.js` first (not the SPA modules) - it checks `GET /api/auth/status` and picks between three screens: **first access** (no login configured yet), **login** (login configured, no valid session), or the real **SPA** (valid session). `<script type="module" src="src/app.js">` is only injected into the DOM (once) after a session is confirmed - this imports `core/router.js` plus the six `view.js` modules under `views/`, which never need to worry about authentication, every call they make is already part of a valid session.
- **First access** (`POST /api/auth/setup`, no session - this is how the first session is born): only works **once**, while the `auth_config` table is empty - the second attempt (from any browser) already gets `409`, so this route can't be used to "reset" an existing login. Whoever gets there first picks a username and password (min. 8 characters) right in the browser, with a "🎲 Generate strong password" button (`crypto.getRandomValues`, 20 characters, generated in the browser itself - the generated password never travels anywhere before you submit it) and a button to reveal/copy what was generated, since a good random password isn't something you can memorize. Success immediately creates a session and logs in - no need to type again what you just created.
- **Login** (`POST /api/auth/login`) checks the username/password with a constant-time comparison (`crypto.timingSafeEqual`) against the stored hash (`crypto.scryptSync`, random salt per password - `api/src/features/auth/credentials.js`) and, if it matches, creates a session: a random 32-byte token stored in the SQLite `sessions` table with a 90-day validity, returned as an `HttpOnly` cookie (`pi_dashboard_session`).
- **Staying logged in**: since the session lives in the database (not in process memory), it survives `docker compose restart`/`up -d --build` of the API container - tested in practice: log in, restart the container, and the same session (same cookie) is still valid without asking to log in again.
- **Changing username/password later** (`POST /api/auth/change-credentials`, Settings screen → "Login"): unlike first access, this requires an active session **and** the current password as proof (being logged in isn't enough - if someone left a session open, they'd still need to know the password to hijack the account). On success, it **invalidates every session** (including the one that made the change) - the frontend reloads the page on its own, landing on the login screen. No email/2FA confirmation (there's no concept of email here) - just the current password.
- Every `/api/*` route (except `/api/health` and the four `/api/auth/*` ones) goes through the `requireAuth` middleware before doing anything - responds `401` without a valid session.
- **Logout** (`POST /api/auth/logout`) deletes the session from the database and clears the cookie. "Sair" button in the sidebar footer.
- A session that expires on any call (not just the initial load) goes back to the login screen on its own: `web/auth.js` wraps `window.fetch` globally, and any `401` response from any call (made by any SPA module or not) triggers the login screen again, without every fetch function needing to handle it individually.
- If the database never had a login configured (`auth_config` empty) - and `BASIC_AUTH_PASSWORD` is also blank - `checkCredentials` refuses **every** login via `/api/auth/login`, but `needsSetup` is `true` and the first-access screen handles it in the UI. That's different from "wrong password": it's "no password exists yet".
- No explicit CSRF protection (token) - the session cookie uses `SameSite=Lax`, which already blocks most cross-site POST cases with an automatic cookie, but isn't a complete guarantee. Acceptable under the current trust model (internal network, one user); revisit if that changes.
- Served over plain HTTP (no TLS) in this setup - the cookie doesn't have the `Secure` flag, on purpose (browsers discard `Secure` cookies outside HTTPS, which would break login). One more reason to never expose this to the internet.

**Unattended/scripted install**: fill in `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` in `.env` **before** the first boot - `auth.js` seeds `auth_config` from them at that point (the log confirms it: `seeded login from .env for user "..."`), and the first-access screen never shows up (`needsSetup` is born `false`). Only matters on the first boot with an empty database - after that, editing `.env` has no effect, same rule as always (change it only from the Settings screen).

## API Endpoints (via nginx proxy)

Login (the only `/api/*` routes outside `requireAuth` - see [Authentication](#authentication)):

- `POST /api/auth/setup` - body `{ username, password }`. Only works while no login exists yet (`409` if one already does - see [Authentication](#authentication)); `400` if `password` is under 8 characters. Success already returns `Set-Cookie` - logs in directly, no separate `/login` call needed afterward.
- `POST /api/auth/login` - body `{ username, password }`. `200 + Set-Cookie` on match; `401` otherwise.
- `POST /api/auth/logout` - deletes the session and clears the cookie.
- `GET /api/auth/status` - `{ authenticated: true|false, needsSetup: true|false }`, never errors even without a session.
- `POST /api/auth/change-credentials` - **requires an active session** (the only auth route that does - the four above exist specifically to work without one). Body `{ currentPassword, newUsername, newPassword }`; `401` if `currentPassword` doesn't match the stored hash, `400` if `newUsername` is empty or `newPassword` is under 8 characters. Success deletes every session (including the one that made the call).

Reads:

- `GET /api/health` - simple liveness check `{ status, timestamp }`.
- `GET /api/system` - full snapshot: `system` (cpu, temperature, memory, load average, uptime, hostname/os/kernel/arch), `storage` (`/` and `/mnt/touro`), `docker` (container list with cpu/mem/pids), `miner` (the `bitcoin-miner` section, if present), `network` (`totalRxBps`/`totalTxBps` plus an `interfaces` list, each with current rate and total accumulated since boot), `internet` (public-internet connectivity/quality - `connected`, `latencyMs`, `avgLatencyMs`, `jitterMs`, `packetLossPercent`, `recentChecks` (last ~30 individual checks, oldest first), `downloadMbps`, `uploadMbps`, `speedTestedAt`, `speedtestInFlight`, see [Internet connectivity](#internet-connectivity) below), `updates` (count of apt packages with an update available), `cloudflared` (tunnel status), `tailscale` (connection status) - the last two, plus `updates`, come from optional scripts on the host, see [Optional host integrations](#optional-host-integrations).
- `GET /api/metrics/history?hours=24` - CPU/RAM/temperature/internet-availability samples (one every ~1min, up to 7 days of retention) for the Overview's "History" chart - separate from the 5-minute in-browser-memory history (see the end of this section). Only accumulates a sample while at least one dashboard tab is open calling `/api/system` (it's piggybacked on that same call, not a separate poller - see [Database (SQLite)](#database-sqlite)). Each sample also carries `internetConnected`/`internetLatencyMs` (read from the same `internet` snapshot already in that `/api/system` response, not a second network check) - the History panel's "Internet" tile resamples `internetConnected` (`true`/`false`) the exact same way it resamples the numeric metrics, since averaging 1s/0s over a bucket is already an uptime fraction for that window.
- `GET /api/processes/top` - `{ available, topCpu, topMem }`, up to 8 real host processes in each list (name, PID, `cpuPercent`/`rssBytes`). Comes from `features/system/processes.js`'s poller cache (every 5s), never scans `/proc` at request time.
- `GET /api/docker/containers` - same shape as the `docker` field above, plus `imageUpdates` (`{ "<image>": { updateAvailable, checkedAt, error } }` - Docker Hub image-update checker, runs every 12h in the background; locally built images, with no registry digest, never show up here).

System actions:

- `POST /api/system/reboot` - reboots the host (`features/system/power.js`). The API container has no privilege of its own to do this (not `--privileged`, read-only root filesystem, and `pid: host` only grants visibility, not control - see that flag's own comment in `docker-compose.yml`), so it goes through the Docker socket instead: it starts a tiny, throwaway `--privileged --pid=host` helper container whose only job is to run `reboot`. Sharing the host's PID namespace puts that helper inside PID 1's namespace, where a privileged `reboot(8)` reboots the physical machine rather than just tearing down the helper container itself. Responds as soon as the reboot is triggered, not once the host is actually back - there's no "finished" event to wait on. Logged to the audit trail as `system.reboot`.
- `POST /api/system/internet/speedtest` - triggers `features/system/internet.js`'s bandwidth test on demand (the Internet screen's "Testar agora" button), instead of waiting for its 15min scheduled run. Unlike `/system/reboot`, this **awaits** the actual transfer before responding (a real few-MB download/upload, not a cached number) and returns the refreshed `internet` snapshot. Coalesced server-side with the scheduled poller - if one's already running, this just awaits that same run rather than starting a second, overlapping test.

Container management (see the section below):

- `POST /api/docker/containers/:id/start`
- `POST /api/docker/containers/:id/stop`
- `POST /api/docker/containers/:id/pause`
- `POST /api/docker/containers/:id/unpause`
- `POST /api/docker/containers/:id/restart`
- `POST /api/docker/containers/:id/recreate`
- `POST /api/docker/containers/:id/remove` - only removes if the container isn't running (409 otherwise).
- `GET /api/docker/containers/:id/details` - formatted `docker inspect` (command, env, ports, mounts, networks, restart policy, compose project).
- `GET /api/docker/containers/:id/logs?tail=200` - Server-Sent Events, live tail.
- `POST /api/docker/projects/:project/:action` - runs `start`/`stop`/`restart` on every container with the `com.docker.compose.project` label equal to `:project` (one at a time, each one going through the same self-protection guard). Response includes `results` with the individual result of each container.

docker-compose management (see the section below - only works for the projects in `COMPOSE_PROJECTS`):

- `GET /api/compose/projects` - names of the compose-manageable projects.
- `GET /api/compose/projects/:project/file` - raw contents of `docker-compose.yml`.
- `PUT /api/compose/projects/:project/file` - saves new content (body `{ content }`); validates with `docker compose config -q` before writing, 400 if invalid, the original file isn't touched in that case.
- `GET /api/compose/projects/:project/run/:action` - Server-Sent Events; `:action` is `pull`, `up` (= `up -d --remove-orphans`), or `down`. GET because `EventSource` can only do GET - same reason as the logs endpoint.
- `GET /api/compose/registry` - `{ active, pendingAdd, pendingRemove, restartNeeded }`: `active` is what's actually mounted right now (from the process's current `COMPOSE_PROJECTS`); `pendingAdd`/`pendingRemove` compare against what `docker-compose.override.yml` says on disk right now - the difference only exists between a UI register/remove and the next restart.
- `POST /api/compose/registry` - registers a new project, body `{ name, path }` (`name`: lowercase/digits/`-`/`_`, `path`: absolute on the host). Only writes the intent to `docker-compose.override.yml`; doesn't check whether the path exists (this process has no access to not-yet-mounted paths) and doesn't apply it on its own.
- `POST /api/compose/registry/:name/unregister` - removes a project from the registry (same deal, only writes, a restart is needed to apply it).

Maintenance:

- `POST /api/docker/prune` - removes every Docker image not referenced by any container (equivalent to `docker image prune -a`). Never touches volumes/containers.

Host (read-only, see [Optional host integrations](#optional-host-integrations)):

- `GET /api/host-schedule` - `{ available, crontab, systemdTimers, stale }`, the user's crontab plus the host's `systemctl list-timers`. `available: false` if the corresponding script has never run on this host yet.
- `GET /api/smart-health` - `{ available, devices, stale }`, SMART health of each disk that supports it (unsupported devices, like an SD card/eMMC, are filtered out, they don't show up as an error). `available: false` until `smartmontools` and the sudoers rule are configured on the host.

Tasks (see [Tasks](#tasks-scheduler) below):

- `GET /api/scheduler/jobs` - lists jobs, each with `lastRun` and up to 10 runs in `runs`.
- `POST /api/scheduler/jobs` - creates a job, body `{ name, schedule, action, enabled? }`. `schedule` is a cron expression validated with `croner`; `action` is `{ type: "compose-update", project }`, `{ type: "docker-prune" }`, or `{ type: "backup", project, retentionDays? }`.
- `PUT /api/scheduler/jobs/:id` - updates any subset of `{ name, schedule, action, enabled }`.
- `DELETE /api/scheduler/jobs/:id` - removes the job (and its history).
- `POST /api/scheduler/jobs/:id/run` - runs the job's action immediately, outside the schedule; returns the same result shape that ends up in the history.

Backups (see [Backups](#backups) below):

- `GET /api/backups/:project` - lists existing backups (name, size, date).
- `POST /api/backups/:project` - generates a backup now, optional body `{ retentionDays }`.
- `GET /api/backups/:project/:filename` - downloads a backup file.
- `DELETE /api/backups/:project/:filename` - removes a specific backup.

Notifications (see [Notifications](#notifications-telegram) below):

- `GET /api/notifications/status` - `{ botConfigured, botUsername, eventTypes, routes }`. `eventTypes` is the fixed list of the 5 known event types (`{ key, label, hasThreshold }`); `routes` carries the state of each (`enabled`, `configured`, `chatIdPreview` - only the last 4 digits -, `label`, `threshold`). **Never** includes the bot token or the full chat ID, in any field.
- `POST /api/notifications/bot` - configures/changes the bot, body `{ token, currentPassword }`. Validates the token against the Telegram API (`getMe`) before saving - `400` if invalid; `401` if `currentPassword` doesn't match; `503` if `APP_ENCRYPTION_KEY` isn't set on the server.
- `DELETE /api/notifications/bot` - removes the bot, body `{ currentPassword }` (same requirement as above).
- `PUT /api/notifications/routes/:eventType` - updates a route, body `{ chatId?, label?, enabled?, threshold? }` (all optional - omitting `chatId` keeps the already-saved chat; an empty string clears it). `404` if `:eventType` isn't one of the 5 known ones.
- `POST /api/notifications/test/:eventType` - sends a test message to whatever chat is configured for that route right now; `400` if the bot or the route aren't configured yet. Returns `{ ok, error }` with Telegram's error message (not an HTTP one) when the send fails, since "validating" a chat ID only really exists by trying to send it something.

Status/Uptime (see [Status (Uptime)](#status-uptime) below):

- `GET /api/uptime/targets` - lists the monitored targets, each already with `lastCheck`, `recentChecks` (the last 40 checks, oldest first - to draw the status bar), and `uptimePercent24h`/`uptimePercent7d`.
- `POST /api/uptime/targets` - creates a target, body `{ name, checkType, target, expectedStatus?, intervalSeconds?, enabled? }`. `checkType` is `"http"` or `"tcp"`; `target` must be a URL (`http`) or `"host:port"` (`tcp`); `intervalSeconds` between 15 and 86400 (default 60).
- `PUT /api/uptime/targets/:id` - updates any subset of the same fields.
- `DELETE /api/uptime/targets/:id` - removes the target (and its check history, via `ON DELETE CASCADE`).
- `GET /api/uptime/targets/:id/history?limit=200` - most recent checks for that target, newest first (up to 500).

The frontend polls `/api/system` every 2 seconds via `fetch`, without reloading the page. The small in-card sparkline charts (CPU, temperature, RAM) show only the last ~5 minutes, in browser memory, and are lost on reload - the separate "History" chart (24h/7d, `GET /api/metrics/history`, CPU/temperature/RAM/Internet) is what covers the longer window, persisted in SQLite.

## Processes and traffic (Overview)

The **CPU**, **RAM**, and **Traffic** cards are clickable (they're `<button>`, not `<div>` - keyboard-focusable like any button) and open a "Resource details" panel right below the card grid, with what's consuming that resource:

- **CPU** / **RAM** → up to 8 host processes (not containers - real processes, read from `/proc/[pid]/stat`+`/proc/[pid]/status`, so things like `dockerd`, `containerd`, `cpuminer`, `node`, etc. show up), sorted by `cpuPercent`/RSS. Updates every 3s while the panel is open (`GET /api/processes/top`), stops updating when it's closed.
- **Traffic** → list of network interfaces (`eth0`, `wlan0`, `tailscale0` on this host - `lo`, `veth*`, `docker*`, `br-*` are filtered out on purpose, they're internal container traffic, not real "internet/LAN" traffic) with current download/upload rate and total accumulated since boot. No extra request - reuses the same `network` data that already comes with every `/api/system` poll.

The Traffic card shows the total rate (sum of every non-filtered interface) - `↓` receiving, `↑` sending.

## Internet connectivity

The **Internet** card (Overview, next to Traffic) answers a different question than the Traffic card: not "how much data is moving" but "does the Pi actually have a working path to the public internet right now, and how good is it". `features/system/internet.js` runs two independent background pollers into the same cache, at very different rates since they cost very different amounts of bandwidth:

- **Ping/loss** (every 10s) - times a plain HTTPS request to an endpoint built for exactly this kind of check - Google's `generate_204` first (empty 204 response, the cheapest possible round trip), falling back to Cloudflare's `cdn-cgi/trace` if that fails - so a single provider having a bad day doesn't read as "internet is down". No ICMP ping involved: the container has neither `CAP_NET_RAW` nor a `ping` binary (see `api/Dockerfile`), and an HTTPS timing check needs neither. The last ~30 samples (~5 minutes) are kept in memory to compute `connected` (did the most recent check succeed), `latencyMs` (that check's round-trip time), `avgLatencyMs`/`jitterMs` (mean and mean-consecutive-difference over the window, among successful checks only), and `packetLossPercent` (share of the window that failed both targets).
- **Download/upload speed** (every 15min by default, `INTERNET_SPEEDTEST_INTERVAL_MS`) - an actual bandwidth test, unlike the check above: it deliberately moves 5MB down / 2MB up (`INTERNET_SPEEDTEST_DOWNLOAD_BYTES`/`INTERNET_SPEEDTEST_UPLOAD_BYTES`) against `speed.cloudflare.com`'s public `__down`/`__up` endpoints - the same backend behind speed.cloudflare.com itself, no account or API key needed, and unrelated to this host's own cloudflared tunnel (that's a private tunnel to Cloudflare's edge; this is a plain public HTTPS request like any other). Runs far less often than the ping check on purpose, and a failed/timed-out run just keeps whatever `downloadMbps`/`uploadMbps` were last measured rather than blanking the card - a dropped test says more about that one attempt than about the link.

The card shows the numbers themselves - ping (ms), loss (%), download/upload (Mbps) - always, rather than a state word like "Unstable": the ping number is colored from fixed thresholds (loss above 10% or average latency above 100ms turns it amber, no response turns it red) so the color still gives an at-a-glance read, but doesn't hide the numbers behind it. The card itself is a `<button>` linking to `#internet` (`location.hash = '#internet'`), the same click-to-drill-down idea as the CPU/RAM/Traffic cards, just landing on its own screen instead of a same-page panel - there's more here than that panel shape comfortably fits.

**Internet screen** (`#internet`, `views/internet/view.js`) - a deep-dive on the same data behind the card, in three panels:

- **Agora** - every field the card has plus `avgLatencyMs`/`jitterMs` (not shown on the compact card), and a **Testar velocidade agora** button (`POST /api/system/internet/speedtest`) to run the bandwidth test on demand instead of waiting for its 15min schedule. Stays live without polling `/api/system` a second time: `views/overview/view.js`'s own 2s poll dispatches a `pd-system-update` window event with the snapshot it already fetched, and this screen just listens for it (same cross-view-event idea `pd-lang-changed` already uses for a language switch) - the one exception is a single fetch on mount, so the screen isn't blank if opened before that poll's first tick has landed.
- **Checagens recentes** - a status-bar rendering (reusing the `.uptime-bar`/`.uptime-tick` styling from the Status screen's per-target bars) of `internet.recentChecks` - the raw last ~30 ping/loss samples (~5 minutes, one per 10s), each tick's tooltip showing its timestamp, result, and latency. Finer-grained than the persisted history below, since these never touch disk.
- **Histórico** - two 24h/7d trend charts (latency, availability), backed by the exact same `GET /api/metrics/history` samples and `resampleHistory`/`drawSparkline` helpers (now in `core/charts.js`, pulled out of `views/overview/view.js` once this screen needed them too) as the compact Internet tile already on Visão Geral's own Histórico panel - just bigger, and with a latency trend line alongside the availability one.

## Optional host integrations

Four pieces of information the API container can't compute on its own, because they depend on a tool installed on the host (not inside the container) or on credentials/state that only exist there: apt packages with an update available, Tailscale status, disk SMART health, and read-only visibility into the host's crontab/systemd timers. None of them is required for the rest of the dashboard to work - each one turns on a specific card/panel that stays **hidden on its own** until you configure it (it doesn't show up with a zeroed-out value or an error, it simply doesn't appear).

All four follow the same pattern, instead of giving the container more access to the host: a Python script runs in the **user's own crontab** (`host-status/check-*.py`, no root or systemd needed) and atomically writes a JSON file into `host-status/`, which is already mounted `:ro` inside the API container (`/host/pi-dashboard-status`) - the same mount serves all four. The matching module under `api/src/features/system/` only reads that file; it never calls the real command itself. A script that stopped running (crontab entry removed, script broken) doesn't break anything - the corresponding card simply marks the data as `stale` after a while without an update, instead of continuing to show an old value as if it were current.

- **Updates (apt)** - `check-apt-updates.py` runs `apt list --upgradable` (no root needed; doesn't run `apt-get update` itself, relies on the `apt-daily.timer` that already exists on a stock host). "Atualizações"/Updates card in the Overview's System panel.
- **Tailscale** - `check-tailscale-status.py` runs `tailscale status --json` (no root needed on this host - `tailscaled`'s socket is already readable by a regular user). "Tailscale" card on Overview, same shape as the Cloudflare "Túnel"/Tunnel card (which doesn't depend on this integration - it reads `cloudflared` directly over the Docker network, see [Architecture](#architecture)): connected/disconnected + peers online.
- **SMART** - `check-smart-health.py` is the only one that genuinely needs root (reading SMART attributes requires an ATA/SCSI command only root can issue). See **Extra setup (SMART)** in [INSTALL.md](../INSTALL.md) for the narrow sudoers rule scoped to just that binary. "Saúde dos discos"/Disk health card on Overview - overall health, temperature, power-on time, reallocated sectors per device; devices with no SMART support (SD card/eMMC, common on a Raspberry Pi) are filtered out of the list, they don't show up as an error.
- **Host schedule** - `check-host-schedule.py` reads `crontab -l` plus `systemctl list-timers --all` for the current user (neither needs root). "Agendamento do host"/Host schedule panel on the Tasks screen, read-only - see [Tasks](#tasks-scheduler).

Exact setup commands (crontab entries + the extra SMART step) are in [INSTALL.md](../INSTALL.md), not repeated here.

## Settings

`#settings` screen, six panels:

- **Overview cards** - one switch per card (CPU, Temperature, RAM, Uptime, Traffic, Internet), all on by default. Turning one off hides the card right away (`.hidden` on the element) and persists to `localStorage` (`pi-dashboard:cardPrefs`) - a per-browser preference, not per-account nor synced across devices, since it's purely "what I want to see on my screen", not application state. The Tunnel/Tailscale cards (see [Optional host integrations](#optional-host-integrations)) are deliberately left out of this scheme - they already hide themselves when the matching integration isn't configured, so an extra switch would just duplicate that control.
- **Login** - form to change username/password (current password + new username + new password). See [Authentication](#authentication) for how this works on the backend (hashing, session invalidation, etc.) - this is just the UI.
- **Notifications (Telegram)** - configure the bot and the routes per event type. See [Notifications](#notifications-telegram) below.
- **Active sessions** - lists every non-expired/non-revoked login session (created at, last seen, expires at, IP), with a "revoke" button on each one (except the current session). No polling - only refetches after an action that already justifies it (revoke); a login made somewhere else doesn't show up on its own until you come back to this screen.
- **Audit log** - lists the most recent actions that changed some state, what and when - see the `audit_log` table in [Database (SQLite)](#database-sqlite).
- **Dashboard backup** - "Backup now"/"View backups" buttons for a snapshot of the dashboard's own SQLite (not an external project) - see [Backups](#backups) below.

## Container management (Docker screen)

Reachable from the "Docker" item in the side nav (`#docker` - switches screens instantly, no reload or new tab; the sidebar is shared across the whole SPA, see [Frontend (SPA)](#frontend-spa) below). Below the two main nav items (Overview/Docker), the sidebar lists the docker-compose projects (container count + anchor link that switches to the Docker screen and scrolls to that project's panel) whenever the Docker screen is active. The main content is grouped into one panel per project.

Each project (a group of containers sharing the `com.docker.compose.project` label - e.g. `cloudflared`, `cpuminer-opt`) has **Start project / Stop project / Restart project** buttons in its header, which act on every container in that project at once (via `POST /api/docker/projects/:project/:action`). Containers without that label (standalone, e.g. a manual `docker run`) fall into an "unmanaged" group with no group actions.

Per container, the available buttons depend on its state:

- **running** → Stop, Pause, Restart, Recreate, Logs, Details
- **paused** → Unpause, Logs, Details
- **stopped** → Start, Remove, Recreate, Logs, Details

- **Recreate** - pulls the container's current image (`docker pull`) and recreates the container with the same `Config`/`HostConfig`/networks it had (equivalent to `docker compose pull <service> && docker compose up -d <service>`, but done directly through the Docker Engine API, without reading any compose file). **Doesn't** apply changes made to `docker-compose.yml` since the container was created - it only swaps the image.
- **Remove** - only works with the container stopped (the API responds 409 if it's running or paused).
- **Logs** - opens a panel with a live tail (SSE) of the last ~200 lines plus new lines as they arrive.
- **Details** - opens the same panel (the "Details" tab) with command, ports, mounts, networks, restart policy, compose project/service, and environment variables. Environment variables show up masked (`••••••••`) by default - click a value to reveal it. It's purely a screen-level obfuscation, the real value already reached the browser; it's not protection against someone with network or DevTools access, it just avoids accidentally exposing a secret in a screenshot/shared screen.

A yellow "update available" badge shows up next to the image name when the background checker (`features/docker/image-updates.js`, every 12h) finds a different digest on Docker Hub compared to what's pulled locally - it only warns, it never pulls or recreates on its own (that stays manual, via Recreate/Pull). Only works for images that come from a registry (Docker Hub today - another registry is silently ignored) with a real local digest; a locally built image (the two belonging to pi-dashboard itself, `cpuminer-opt:local`) never shows this badge, there's nothing to compare.

`pi-dashboard-api` and `pi-dashboard-web` (this dashboard's own two containers, grouped under the `pi-dashboard` project) show up in the list with only Logs/Details available - `features/docker/lifecycle.js` blocks any lifecycle action on them (start/stop/pause/restart/recreate/remove, and the same applies when called via a project action), because stopping/recreating `web` would cut off the only way back into the UI, and recreating `api` would take down the very process handling the request. The `pi-dashboard` project's header doesn't show the group action buttons for that reason. To update the dashboard itself, use `docker compose` on the host.

There's no two-step confirmation on the backend - Stop/Restart/Recreate/Remove and the project actions only ask for confirmation in the browser (`confirm()`), so a direct call to the API (bypassing the UI) executes right away.

## docker-compose management

Only exists for registered projects (today: `cloudflared`, `cpuminer-opt` - **doesn't** include `pi-dashboard`, on purpose, for the same reason as the self-management block above; and can't, really, because the pi-dashboard project itself is never mounted into this container). Each registered project's panel gets a toolbar above the container table:

- **Pull** - `docker compose pull`.
- **Up (apply .yml)** - `docker compose up -d --remove-orphans`. Unlike per-container Recreate (which only swaps the image), this reads the current `docker-compose.yml` and recreates any service whose config changed - it's how you apply an edit made in the editor below.
- **Down** - `docker compose down` (stops and removes the project's containers and network; **doesn't** pass `-v`, so named volumes aren't deleted). Asks for confirmation, since it zeroes out the project until someone runs Up again.
- **Edit docker-compose.yml** - opens a plain text editor with the current content. "Save" validates with `docker compose config -q` first; if invalid, shows the error and **doesn't** write anything. Saving only writes the file - it doesn't restart anything on its own, you have to run "Up" afterward to apply it.

Each command's output shows up live (SSE) in a log box below the toolbar. A compose-managed project keeps showing up in the sidebar and has its panel rendered even with **zero containers running** (e.g. right after a Down) - otherwise there'd be no way to Up it again from the UI. While a project's editor or output box is open, the 5s poll skips re-rendering that specific panel (so it doesn't wipe what you're editing or disrupt the output box mid-stream) - everything else keeps updating normally.

The editor doesn't mask anything in the text (unlike the container Details tab, which masks env vars one by one) - there's no reliable way to mask a secret sitting anywhere in free-form YAML without risking breaking the edit. The `cloudflared` project's `docker-compose.yml`, for example, has the tunnel token in plaintext inside `command:`. A warning shows up at the top of the editor as a reminder.

**Important note about the bind mounts**: each project is mounted into the API container **at the exact same absolute path it has on the host** (not at some other path like `/compose-projects/<name>`). This isn't just cosmetic - `docker compose` resolves the `.yml`'s relative paths (`./data`, `env_file`, build context) into absolute paths using the directory it's run from, and those absolute paths are what goes to the Docker daemon, which runs on the **host**, not inside this container. Mounting at a different path already caused a real incident during development: `uptime-kuma`'s `./data` volume got resolved to a path that only existed inside the API container, and an `up -d` recreated the container pointing there - the real data was orphaned for a few minutes until it was recovered by running `docker compose up -d --force-recreate` directly from the host. `registerProject` (below) always mounts source == destination automatically because of this; if you ever edit the registry by hand, keep that rule.

### Registering a new project via the UI

At the top of the management screen there's a "Projetos docker-compose"/docker-compose projects panel with a form: **name** (lowercase/digits/`-`/`_`) and **absolute path on the host** (the directory needs a file named `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, or `compose.yaml` - `features/compose/run.js` looks for all four names, in that order, for any project, whether registered via the UI or mapped directly in `COMPOSE_PROJECTS`). "Register project" only writes the intent to `docker-compose.override.yml` (`POST /api/compose/registry`) - it doesn't mount anything right away, because this container can't recreate itself with a new mount in the middle of its own request.

After registering, the project shows up in the list as **pending** ("novo"/new badge, with a "cancel" button to back out without needing a restart) and a yellow banner asks you to apply it:

```bash
cd pi-dashboard
docker compose up -d --build
```

After that restart, the project becomes truly active: it shows up in the sidebar, gets its own panel with Pull/Up/Down/Edit/**Remove project**, and starts counting toward `GET /api/docker/projects`. "Remove project" (with confirmation) follows the same flow in reverse: writes the removal to `docker-compose.override.yml`, the project stays active and functional until the next restart, and only disappears from the "compose-manageable" list after that (the containers themselves aren't touched - they just lose Pull/Up/Down/Edit).

There's no check that the path exists or has a valid `docker-compose.yml` at registration time - this process can only see paths already mounted, so a wrong path only shows up as an error after the restart (the project simply doesn't appear in `GET /api/docker/projects`).

## Backups

Each compose-managed project's panel (Docker screen) has a **Backup now** and **View backups** button in the same toolbar as Pull/Up/Down. Convention, not configuration: a project is only "backupable" if it has a `data/` subdirectory (neither `cloudflared` nor `cpuminer-opt` has one today, so "Backup now" on them returns `skipped` explaining that, not an error). No new field had to be added to the project registry for this - it already covers today's real cases.

- **What**: `tar -czf` of the entire `data/` directory, filename with a timestamp (`<project>-<ISO8601>.tar.gz`).
- **Where**: `/mnt/touro/backups/<project>/` on the host (dedicated mount, see Architecture above).
- **Retention**: optional, in days - passed on a manual call (`POST /api/backups/:project` with `{ retentionDays }`) or fixed on a scheduled job (the `backup` action). Backups older than that are deleted **after** the new backup is created successfully, never before.
- **View backups**: lists name/size/date for each file, with a **download** link (direct download, browser auth already covers it) and **delete**.
- **Restore**: doesn't exist via the UI - it's the riskiest part (overwriting real data), left out on purpose. To restore, download the `.tar.gz`, stop the project's container, and manually extract it over the real `data/` on the host.

**Backing up the dashboard itself**: pi-dashboard never shows up in the project list above (it can't self-register - see [docker-compose management](#docker-compose-management)), so a snapshot of its own SQLite (jobs, uptime targets, bot config, the login) has the same **Backup now**/**View backups** buttons, just on the Settings screen, "Dashboard backup" panel. Uses `better-sqlite3`'s `Database#backup` (the online backup API, safe even with the database in use and in `journal_mode = WAL`) instead of copying the `.db` file by hand, which could catch a write mid-flight. `"pi-dashboard"` is the special project name the backend recognizes to know this is that snapshot, not a real project's `data/`.

## Tasks (scheduler)

A "visual cron" that belongs only to the dashboard - it **never** reads or writes the host's crontab or systemd timers. Only schedules actions the API already knows how to do:

- **Update project (`compose-update`)** - `docker compose pull` followed by `up -d --remove-orphans` on the chosen project (the same function used by the manual Pull/Up buttons).
- **Prune unused images (`docker-prune`)** - same action as the "Limpar imagens não usadas"/Prune unused images button on the Docker screen.
- **Backup a project (`backup`)** - same action as the "Backup now" button, with optional retention.
- **Backup the dashboard (`self-backup`)** - same action as the "Backup now" button under Settings → Dashboard backup (see [Backups](#backups)), with optional retention.

The "Agendamento do host"/Host schedule panel right below the job list (same screen) shows, **read-only**, the current user's crontab plus the host's `systemctl list-timers` - including the entries the [optional host integrations](#optional-host-integrations) add. There's no action button there at all (not even edit or pause) - it's purely for visibility, so you don't need to open a terminal just to remember what's already scheduled on this Pi outside the dashboard.

Jobs are created on the Tasks screen: name, action type (+ project, when applicable), a cron expression (free text field, with three shortcut buttons: daily at 3am / hourly / weekly on Sunday at 3am), and a retention in days (backup only). The expression is validated with the `croner` library on creation - an invalid cron is rejected with 400 before it's saved.

Each job shows the result of its last run (success/skipped/failure + time) and keeps the last 10 runs (`GET /api/scheduler/jobs`), each with the action's output - visible by clicking "Ver histórico"/View history. **Run now** fires the action immediately, outside the schedule, useful for testing a new job without waiting for its time - that run is **always a single attempt**, to give an immediate answer to whoever clicked it. A job triggered by cron, on the other hand, automatically retries up to 2 more times (30s backoff, then 2min) before marking it as failed for good - the extra attempts are recorded in the same history row, not as separate runs. A backup that returns "skipped" (no `data/` to copy) doesn't count as a failure and doesn't enter that retry - there's nothing to try again. **Pause/Resume** turns it on and off without deleting the job; **Delete** removes the job and its history, with no extra confirmation beyond the browser's `confirm()`.

Persisted in the SQLite database's `jobs`/`job_runs` tables (see the section below) - before that it was a `scheduler-jobs.json` file, automatically migrated the first time the dashboard boots with a fresh database.

There's no job editor in the UI today (changing name/action/schedule) - only create, pause/resume, run now, and delete. To "edit", delete and recreate.

## Notifications (Telegram)

Alerts via a Telegram bot for 5 event types, each routable to a different chat/group. Lives on the Settings screen, "Notificações (Telegram)" panel.

**Configuring the bot** (once): create a bot with [@BotFather](https://t.me/BotFather) on Telegram, copy the token, paste it into the form along with the panel's current password (same requirement as `changeCredentials` - see [Authentication](#authentication)). The server checks the token against the Telegram API (`getMe`) before saving, so a wrong token is rejected right away, not only when a real alert tries to fire. **The token is never redisplayed once saved, in any screen or API response** - the panel only shows `@bot_name ✓`; to change it, "Trocar token"/Change token opens the form always empty.

**Routes per event type**: each of the 5 types below has its own chat ID, optional label, on/off switch, and a "Testar"/Test button (sends a real message to the configured chat, useful to confirm the bot was added to the right group before waiting for a real alert to happen). The chat ID, once saved, also never comes back to the browser - the panel only shows the last 4 digits (`chat …1234`) to help tell routes apart, and the "change" field always starts empty.

- **Job/backup failure** (`job_failure`) - fires from inside `features/scheduler/runner.js`, every time a scheduled job's action ends in an error (the same trigger that marks the run as "falhou"/failed in the Tasks screen history).
- **Container down** (`container_down`) - a background poller (`features/system/health-watch.js`, every 30s by default) compares each container's state against the previous tick and fires only on the `running` → anything-else transition - never again while it stays down, and never on the very first read (which only seeds the cache). This dashboard's own two containers are excluded, the same list (`SELF_CONTAINER_NAMES`) used by `features/docker/lifecycle.js`.
- **Disk above threshold** (`disk_threshold`) - the same poller, compares `/` and `/mnt/touro` against a % threshold defined on the route itself (a numeric field in the form). With no threshold set, this check simply doesn't run. Same debounce: only fires on the below→above transition.
- **Uptime down/recovered** (`uptime_down`) - fired by the checker in the [Uptime module](#status-uptime) (Status screen) every time a monitored target changes state: `"<name>" stopped responding` on the way down, `"<name>" is responding again` on recovery. Same debounce as the others: only on the transition, never on every individual check while it stays in the same state.
- **Restart pending** (`restart_pending`) - same poller as container-down/disk, fires when registering or removing a project via [docker-compose management](#docker-compose-management) leaves things waiting on the manual `docker compose up -d --build` that actually applies it - before this, only the yellow banner on the screen itself existed, easy to miss if nobody's looking. Same debounce: only fires on entering that state, not every 30s while it stays pending.

**Security**: the bot token and chat IDs are encrypted at rest (`AES-256-GCM`, `api/src/lib/crypto/secret-box.js`) with a key derived from `APP_ENCRYPTION_KEY` (`.env`) - without that variable set, saving anything in Notifications fails with a clear error (fail closed, never stores plaintext). Losing or changing `APP_ENCRYPTION_KEY` after configuring it makes everything already saved permanently unreadable, no recovery - same rule already used for the login password. Saving/changing/removing the bot requires the panel's current password, regardless of whether a session is already open (same reason as `changeCredentials`: a session left open on another screen shouldn't be enough to hijack the bot).

**Retry queue**: if Telegram is unreachable (or the token/chat ID has become invalid) at the exact moment of an automatic trigger, the notification enters the `notification_queue` table and retries 3 times (backoff 2min, 10min, 30min) before giving up for good (logged, not retried forever). Each attempt re-resolves the route (token/chat) at that moment, so fixing the config in the meantime already takes effect on the next retry. The "Testar"/Test button deliberately stays out of this queue - it always tries immediately and shows Telegram's error (e.g. `Unauthorized`, `chat not found`) directly in the form, without waiting on any retry.

## Status (Uptime)

Monitoring of **external URLs/services** - not containers (that's already covered by the "Container caiu"/Container down alert in [Notifications](#notifications-telegram)). `#status` screen, reachable from the "Status" item in the side nav.

**Why a checker of its own, instead of `uptime-kuma`** (which used to run on this host, as a registered `docker-compose.override.yml` project, before this feature existed): it spoke Socket.IO (a logged-in user session), didn't expose a stable REST API without a specific plugin/version, and nothing on this host had an API key configured for it. Reading its SQLite directly would also have competed with its own `journal_mode = WAL`. A checker of its own, following the same pattern already used by `features/system/miner.js`/`features/system/processes.js` (in-memory poller + SQLite), turned out simpler and more robust than integrating with an undocumented protocol. Once this feature covered the same ground, `uptime-kuma` was decommissioned (container removed, unregistered from the compose project registry, `uptime-kuma/` deleted from the host).

**Registering a target**: name, type (`HTTP(S)` or `TCP`), the target itself (a full URL for the HTTP type, `host:port` for TCP), expected HTTP status (optional - without it, any `2xx` counts as success), and the interval between checks (15s to 24h, default 60s, with 30s/1min/5min shortcuts). The **Edit** button on each target reuses this same form (switches into edit mode, with a "Cancelar edição"/Cancel editing button to go back) instead of having a separate form - saves with `PUT /api/uptime/targets/:id`, the same fields as registration.

**How it checks**: a single background poller (`features/uptime/checker.js`) runs every `UPTIME_CHECK_TICK_MS` (default 15s) and, on every tick, checks any target whose interval has already elapsed since the last check - it's not a per-target timer. `HTTP(S)`: a `fetch` with a 10s timeout; success is `2xx` (or the exact configured status). `TCP`: tries to open and close the connection (`net.connect`) with a 5s timeout; success is just connecting. Every check writes a line with latency/error to the history (`uptime_checks` table), pruned to keep only the last 30 days per target.

**Each target card shows**: a status dot (green/red/gray = never checked), latency and time of the last check, uptime % over the last 24h and 7 days (computed from the saved history, `null` if there aren't checks yet in that period), a bar of small green/red rectangles with the last ~40 checks (hover one to see the time/latency), and "Ver histórico"/View history (expands up to 200 checks, same look as the run history box on the Tasks screen). **Pause/Resume** buttons (stop/resume checking without deleting the target) and **Delete** (deletes the target and its whole history, via `ON DELETE CASCADE`).

**Alerts**: every state transition (ok → failing, failing → ok) fires the `uptime_down` event in [Notifications](#notifications-telegram) - configure that route to receive it on Telegram. Same debounce as the other triggers: only on the transition, never on every check while it stays in the same state, and never on the very first check of a newly created target (that one only sets the initial state).

## Database (SQLite)

`api/src/lib/db.js` opens (and creates, if it doesn't exist) a SQLite database at `APP_DATA_DIR/pi-dashboard.db` (`/data`, the named Docker volume `pi-dashboard-data` - not a bind mount, not `/tmp`: it needs to survive `docker compose up -d --build`, which `/tmp` doesn't). `journal_mode = WAL` and `foreign_keys = ON` are turned on at open. The volume is created empty on first boot with the right owner (`node:node`) because `api/Dockerfile` already creates `/data` with that owner before switching to `USER node` - a new volume inherits the ownership of whatever already exists at that path in the image.

Tables today:

- `jobs` / `job_runs` - scheduler (see [Tasks](#tasks-scheduler)). `job_runs.skipped` tells apart a backup that found no `data/` to copy (not a failure) from a job that genuinely failed.
- `sessions` - login sessions (see [Authentication](#authentication)).
- `auth_config` - the login username/password (hash), a single row (`id = 1`). Created on the first-access screen (or seeded from `.env`, if filled in before the first boot); after that, only changes via the Settings screen.
- `notification_bot` - the Telegram bot token (encrypted) + `@username`, a single row (`id = 1`). See [Notifications](#notifications-telegram).
- `notification_routes` - one fixed row per event type (`job_failure`/`container_down`/`disk_threshold`/`uptime_down`/`restart_pending`), with an encrypted chat ID, label, threshold (disk only), and on/off. See [Notifications](#notifications-telegram).
- `notification_queue` - retry queue for notifications that failed on their first send (3 attempts, 2/10/30min backoff before giving up). Doesn't store token/chat - re-resolves the route from `notification_routes`/`notification_bot` at retry time, so a route fixed along the way already takes effect on the next retry.
- `uptime_targets` / `uptime_checks` - monitored targets and check history (pruned to the last 30 days per target). See [Status (Uptime)](#status-uptime).
- `audit_log` - the last 500 actions that changed some state (container, compose, backup, credentials, notifications, uptime target, job), with when/what/target/detail. Doesn't store who - login is a single shared user, there's no way to know. See the "Log de auditoria"/Audit log panel in [Settings](#settings).
- `metrics_history` - CPU/RAM/temperature samples for the Overview's "History" chart (up to 7 days, one sample every ~1min). See [API Endpoints](#api-endpoints-via-nginx-proxy).

Meant as the general place for anything the application needs to store - it isn't exclusive to the scheduler, that was just the first thing to use it.

**Driver**: `better-sqlite3`, but **pinned to `11.10.0`** (`package.json`, not `^11.10.0` or newer) - the most recent version (13.x, at the time) has a real bug: the prebuilt binary it bundles for `linux-musl/arm64` (this Alpine, on this Raspberry Pi) segfaults on load, and building from scratch (with or without LTO) produces the same broken binary - it's not a build config issue, it's the version itself. `11.10.0` works - loads and passes a manual test (`node -e "require('better-sqlite3')"` inside the already-built image) with nothing to compile. **If you ever update this dependency, run that manual test inside the already-built image before trusting it** - this kind of bug doesn't show up any other way until it takes down the dashboard running for real.

`api/Dockerfile` doesn't need `python3`/`make`/`g++` because of this - v11.10.0 uses a prebuild, `npm ci` alone is enough.

If the `bitcoin-miner` container exists, a dedicated section shows its state, CPU, RAM, container uptime, image, status, and the most recent hashrate. The hashrate is **not** read from the logs on every request: a background poller (default 20s, configurable via `MINER_LOG_POLL_INTERVAL_MS`) tails the last few log lines, extracts the `Hash rate` line, and keeps the value cached in memory. `/api/system` only reads that cache. If the container doesn't exist, the section shows "not present".

## Error handling

- Metric unavailable → the API returns `null` for the field, the frontend shows `--`.
- Temperature unavailable → the frontend shows `N/A`.
- Docker unavailable → the Docker section shows an error warning; the rest of the dashboard (system, storage) keeps working normally.
- A management action fails (container not found, image doesn't pull, etc.) → the API responds with an error status and message; the management screen shows the message in a red banner at the top and doesn't change the list until the next refresh (5s).

## File structure

```
pi-dashboard/
├── docker-compose.yml
├── docker-compose.override.yml  (generated by the UI - compose project registry, don't hand-edit; must exist even if empty before the 1st `docker compose up`, see INSTALL.md)
├── .env           (never version/copy between hosts - password and paths for this host)
├── .env.example   (template to copy into .env on a new host)
├── LICENSE
├── README.md
├── INSTALL.md     (step-by-step setup, including the optional host integrations)
├── docs/
│   └── ARCHITECTURE.md  (this file - how each part works internally)
├── host-status/   (scripts + JSON generated by the optional host integrations - see INSTALL.md)
├── api/
│   ├── Dockerfile
│   ├── package.json
│   ├── package-lock.json
│   └── src/
│       ├── server.js       (just wiring: express + mounts the routers below + starts the pollers)
│       ├── lib/             (infra with no business logic, importable by any feature)
│       │   ├── db.js         (SQLite - see Database)
│       │   ├── docker-client.js (shared dockerode instance)
│       │   ├── logger.js
│       │   ├── errors.js     (ActionError - an error with a statusCode, used by every feature)
│       │   └── crypto/secret-box.js  (reversible AES-256-GCM encryption - see Notifications)
│       ├── middleware/
│       │   ├── async-handler.js  (forwards an async route's error to the error-handler)
│       │   └── error-handler.js  (one central error handler for every route)
│       ├── routes/          (one file per resource, each an express.Router())
│       │   ├── auth.routes.js, system.routes.js, host.routes.js, docker.routes.js,
│       │   └── compose.routes.js, scheduler.routes.js, backups.routes.js, audit.routes.js,
│       │       notifications.routes.js, uptime.routes.js
│       └── features/        (domain logic - each router above calls into one of these; every
│           │                 folder here past ~200 lines is split by concern, not one file each)
│           ├── auth/                        (credentials.js: login/password · sessions.js: cookie
│           │                                +session table+requireAuth - see Authentication)
│           ├── docker/                     (lifecycle.js: start/stop/.../recreate · inspect.js:
│           │                                details/logs · project.js: bulk actions+prune ·
│           │                                metrics.js: read-only container+stats · image-updates.js)
│           ├── compose/                    (registry.js: docker-compose.override.yml registry ·
│           │                                run.js: docker compose pull/up/down + read/save .yml)
│           ├── backups/                    (actions.js: tar a project's data/ · self-backup.js: the dashboard's own SQLite snapshot)
│           ├── scheduler/                  (store.js: jobs/job_runs tables · runner.js: cron
│           │                                instances+execution - see Tasks)
│           ├── notifications/              (store.js: tables · telegram.js: Telegram API ·
│           │                                dispatch.js: notify(eventType,...) · retry-queue.js: backoff resend)
│           ├── uptime/                     (targets.js: uptime_targets table · checks.js:
│           │                                uptime_checks table · checker.js: HTTP/TCP poller)
│           ├── audit/audit.js
│           └── system/                     (host metric readers - system, storage, network,
│               internet, processes, miner, health-watch, history-store, apt-updates, cloudflared,
│               tailscale, smart, host-schedule)
└── web/
    ├── Dockerfile        (multi-stage: builds the Tailwind CSS on its own, then just nginx)
    ├── nginx.conf
    ├── index.html        (app shell only: login/setup screens + sidebar + one <pd-view-*> tag per screen, see Frontend)
    ├── auth.js            (loaded first - login/setup screen, only injects src/app.js after a session is confirmed)
    ├── package.json       (just the Tailwind dependency - the build happens inside the Docker image, see Dockerfile above)
    ├── package-lock.json
    ├── style.css           (GENERATED at image build time - don't hand-edit, see Styling (Tailwind))
    └── src/
        ├── input.css        (Tailwind source - design tokens + @layer components, see Styling)
        ├── app.js            (entry point - native ES modules, no bundler: imports and starts each view)
        ├── core/              (format.js/dom.js/router.js/charts.js - helpers shared across views)
        └── views/              (overview/docker/tasks/status/internet/settings - one folder per
                                   screen, each with view.js (custom element + logic) and
                                   template.html (its markup, fetched at mount time))
```

## Known limitations

- The first `cpuPercent` read (system-wide and per container) returns `null`/low precision because the calculation depends on a previous `/proc/stat` sample - it stabilizes on the next cycle (~2s).
- The miner's hashrate depends on `cpuminer-opt`'s log format (the `Periodic Report` / `Hash rate` line); if the binary changes its log format, the regex in `miner.js` will need adjusting.
- Temperature is read from `/sys/class/thermal/thermal_zone0/temp`; `vcgencmd` isn't available on this host (no `/dev/vcio`), so that path isn't used.
- The in-card sparkline charts (last ~5 minutes) exist only in browser memory (by design) - lost on reload. Only the separate "History" chart (24h/7d) is persisted in SQLite - and even that one only accumulates a sample while some dashboard tab is open (see [API Endpoints](#api-endpoints-via-nginx-proxy)).
- The Docker image-update checker only knows how to talk to Docker Hub (anonymous token + v2 API manifest) - an image from another registry (`ghcr.io`, etc.) is silently ignored, never shows up as "can't check" nor raises an error.
- Registering/removing a project via the UI never applies on its own - it always needs a manual `docker compose up -d --build` (or asking Claude) afterward, because the API container can't recreate itself with a new mount in the middle of its own request. There's no mechanism today to notify when this gets forgotten, beyond the yellow banner on the screen itself.
- `Up (apply .yml)` reflects changes to `docker-compose.yml`, but **doesn't** build the image by default (no `--build`) - if the service uses `build:` (the `cpuminer-opt` case) and you changed the Dockerfile/source, `Up` alone doesn't rebuild the image, it only recreates the container with the image that already exists. Rebuilding is still manual on the host for now.
- Backup only covers a single `data/` subdirectory per project - if a future project keeps state somewhere else (multiple directories, a named Docker volume instead of a bind mount, etc.), the backup won't catch anything and "Backup now"/the scheduled job will simply report `skipped` (the UI already flags this: an immediate banner for the manual one, a yellow "skipped" badge + notification for the scheduled one).
- No backup restore via the UI (on purpose - see the Backups section) and no task-job editor via the UI (delete and recreate).
- The scheduler automatically retries (3 attempts, 30s/2min backoff) only when the job is triggered by cron - "run now" is still a single attempt, to give an immediate response to whoever clicked it.
- The login protects access, but doesn't tell apart who did what - every action shows up in the logs with no user attached (there's only one shared username/password, a `sessions` table, not `users`).
- No explicit CSRF token (just `SameSite=Lax`) and no TLS (`Secure` cookie turned off on purpose) - see the caveats in [Authentication](#authentication).
- The first-access screen (`/api/auth/setup`) has no rate limiting - whoever reaches the dashboard's address first after it boots with a blank `.env` is the one who sets the login. Not a problem on a trusted home network (the model this whole project assumes), but it's good to bring the dashboard up and reach the first-access screen as soon as possible after `docker compose up`, without leaving port 8080 reachable from afar in the meantime.
- The password generated by the "Generate strong password" button only exists on screen while you don't leave it - it isn't saved anywhere (not even `localStorage`) beyond whatever you copy/write down. Closing the tab without copying it means having to change the password again after logging in (there's no way to recover the generated one).
- `better-sqlite3` is pinned to `11.10.0` because of a segfault bug in newer versions on this Alpine/ARM64 combo - see [Database (SQLite)](#database-sqlite) before updating that dependency.
- Per-process CPU% (the CPU/RAM details panel) is "% of one core", the same way `top` shows it by default - a process with several threads can go over 100%. Not normalized by core count.
- The CPU/RAM details panel shows processes from the **whole host**, not filtered by container - it includes `dockerd`/`containerd` itself, other containers' processes, and anything running outside Docker on this Pi. That's intentional (it's literally "what's using this resource"), but it isn't a "per-container" view - that one already exists on the Docker screen.
- Card preferences (Settings) are per browser (`localStorage`), not per account - opening the dashboard in a different browser/device shows every card turned back on until you turn them off there too.
- Notifications that fail on the first send enter a retry queue (3 attempts, 2/10/30min backoff) before giving up for good - see [Notifications](#notifications-telegram). There's still no way to see that queue via the UI (only through the container's logs).
- The Status checker only runs from inside the `pi-dashboard-api` container itself - if it goes down or the Pi loses internet, checks simply stop (and no "down" alert fires, since the checker itself is what would fire it). There's no external watchdog checking the checker.
- Uptime % on Status (24h/7d) is computed only from what's left after the 30-day history pruning - for a target created recently, both periods show `--` until there are enough checks within the window.
