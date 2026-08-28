# Pi Dashboard

Admin dashboard for a home-lab server (built for a Raspberry Pi, runs on any Linux + Docker host). One page, no heavy dependencies — no Grafana/Prometheus/InfluxDB, just its own SQLite database.

## Features

- **Overview** — CPU, RAM, temperature, uptime, storage and network traffic at a glance, with drill-down into what's actually consuming each resource; one-click host reboot.
- **Docker** — start/stop/pause/restart/recreate containers, live log tailing, and full `docker-compose` management (pull/up/down, edit `docker-compose.yml`) for any project you register.
- **Tasks** — a built-in scheduler for recurring jobs: update a project, prune unused images, back up a project's data — with history and retries.
- **Status** — uptime monitoring for external URLs and services (HTTP/TCP checks).
- **Notifications** — Telegram alerts for job failures, containers going down, disk thresholds, and uptime changes.
- **Backups** — one-click backup/restore-file download for any registered project's data, with optional retention.
- Own login (no default password shipped), sessions in SQLite, secrets encrypted at rest.

## Quick start

```bash
git clone https://github.com/Conehard/pi-dashboard.git
cd pi-dashboard
cp .env.example .env      # set DOCKER_GID, see INSTALL.md
touch docker-compose.override.yml
docker compose up -d --build
```

Open `http://<host-ip>:8080` and create your login on the first-access screen.

Full step-by-step setup (including optional host integrations like SMART health and Tailscale status): **[INSTALL.md](./INSTALL.md)**.

## Stack

Vanilla JS SPA (no framework/bundler) styled with Tailwind, served by nginx · Node.js/Express API · SQLite (`better-sqlite3`) · talks to the Docker Engine API and `docker compose` on the host.

## How it works internally

Architecture, every API endpoint, the auth flow, and the reasoning behind each design choice are documented in **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**.

## License

[GPLv3](./LICENSE)
