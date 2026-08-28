# Installation

Quick guide to running pi-dashboard from scratch. To understand what each screen does, see the [README](./README.md) - this file is just the setup steps.

## Prerequisites

- A Linux host (built with a Raspberry Pi in mind, but any Linux with Docker works)
- [Docker](https://docs.docker.com/engine/install/) and Docker Compose v2 (`docker compose version` should work, not the `docker-compose` v1 binary)
- A user in the `docker` group (`groups $USER` should list `docker`)

## 1. Clone and configure

```bash
git clone <your-fork-or-repo-url> pi-dashboard
cd pi-dashboard
cp .env.example .env
```

Edit `.env`:
- `DOCKER_GID` - the host's `docker` group gid: `getent group docker`
- `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` - leave `BASIC_AUTH_PASSWORD` blank (recommended); the first time you open the dashboard in a browser, a "first access" screen lets you create the login right there
- `APP_ENCRYPTION_KEY` - only needed if you're going to configure Telegram notifications later (`openssl rand -hex 32`); can be left blank for now and generated later

## 2. Create the (empty) project registry file

```bash
touch docker-compose.override.yml
```

This file is generated and maintained by the UI itself (Docker screen → "Registrar projeto compose-gerenciado") once the dashboard is up - but Docker needs it to already exist (even empty) *before* the first `docker compose up`, otherwise it creates a directory in place of a file at that path and breaks writes to it afterward. Without this step, the dashboard works normally, it just has no compose-managed project yet to show on the Docker screen.

## 3. Bring it up

```bash
docker compose up -d --build
```

This builds both images (the API builds the Tailwind CSS on its own during the build, nothing manual to run first) and starts both containers. Check:

```bash
docker compose ps        # both containers should be "healthy"
docker compose logs -f   # Ctrl+C to exit
```

Open `http://<host-ip>:8080` in a browser - the first-access screen shows up automatically if `BASIC_AUTH_PASSWORD` was left blank in `.env`.

⚠ Bring the dashboard up and reach that screen as soon as possible after `docker compose up` - the first-access screen has no rate limiting, so until someone sets the login, it's a race against anyone else who also reaches port 8080 first. Not a problem on a trusted home network (the model this whole project assumes - see "Authentication" in the README), but don't leave the port exposed to the internet in the meantime.

## 4. Register existing docker-compose projects (optional)

If you already have other projects running via `docker compose` on this host (e.g. a `cloudflared` tunnel) and want to manage them from the dashboard: Docker screen → "Registrar projeto compose-gerenciado", enter a name and the project directory's absolute path on the host. After registering, run `docker compose up -d --build` again (from inside the pi-dashboard directory) to apply it - the dashboard can't recreate itself with a new mount in the middle of a following request, it tells you so on the screen.

## 5. Backups and the Miner card (optional, edit `docker-compose.yml`)

Two things in `docker-compose.yml` are left as real examples from the host this was built on, not generic defaults, since neither has an env var to override - if you want either, edit the file directly:

- **Backups** mount `/mnt/touro` (read-only, for the Storage card) and `/mnt/touro/backups` (read-write, where the Backups feature writes tarballs) - `touro` is a drive name specific to that host. Point both at wherever you want backups to land on yours, or remove them entirely if you don't plan to use the Backups feature; nothing else depends on them.
- **Miner** reads `MINER_CONTAINER_NAME=bitcoin-miner` and polls that container's logs for a hashrate line - only relevant if you actually run a `cpuminer-opt`-style container under that name. Change it to your own container's name, or ignore it: the Miner card just shows "not present" if no container matches.

Both are optional the same way SMART/Tailscale below are - the dashboard works fine without either, the corresponding UI just stays empty/hidden.

## 6. Optional host integrations

None of these are required for the dashboard to work - each one turns on a specific card/panel that stays hidden on its own until you configure it. All of them follow the same pattern: a Python script runs in your own user's crontab (no root/systemd needed) and writes a JSON file into `host-status/`, which the API container already reads read-only.

Add whichever lines you want to your crontab (`crontab -e`), one per integration:

```cron
# Available apt package updates - "Atualizações" card on Overview
0 */6 * * * /usr/bin/python3 /full/path/to/pi-dashboard/host-status/check-apt-updates.py >> /full/path/to/pi-dashboard/host-status/check-apt-updates.log 2>&1

# Tailscale status - "Tailscale" card on Overview (only useful if the host already has Tailscale installed and connected)
*/5 * * * * /usr/bin/python3 /full/path/to/pi-dashboard/host-status/check-tailscale-status.py >> /full/path/to/pi-dashboard/host-status/check-tailscale-status.log 2>&1

# Host crontab + systemd timers, read-only - "Agendamento do host" panel on the Tasks screen
*/15 * * * * /usr/bin/python3 /full/path/to/pi-dashboard/host-status/check-host-schedule.py >> /full/path/to/pi-dashboard/host-status/check-host-schedule.log 2>&1

# Disk SMART health - "Saúde dos discos" card on Overview (see the extra setup below before enabling this one)
*/30 * * * * /usr/bin/python3 /full/path/to/pi-dashboard/host-status/check-smart-health.py >> /full/path/to/pi-dashboard/host-status/check-smart-health.log 2>&1
```

Replace `/full/path/to/pi-dashboard` with the real path where you cloned the project (`pwd` inside the project directory gives you that value).

### SMART - extra setup (the only one that needs root)

The other three run with no privilege at all. SMART is different: reading a disk's attributes requires ATA/SCSI commands only root can issue. Since this whole pattern assumes the host has no passwordless sudo (otherwise the crontab entry above wouldn't run without hanging on a password prompt), the way out is a narrow sudoers rule scoped to just the `smartctl` binary:

```bash
sudo apt-get install -y smartmontools
echo "$USER ALL=(root) NOPASSWD: /usr/sbin/smartctl" | sudo tee /etc/sudoers.d/pi-dashboard-smartctl
sudo chmod 440 /etc/sudoers.d/pi-dashboard-smartctl
sudo visudo -c   # validate the file before trusting it
```

After that, add the `check-smart-health.py` line to your crontab (above). The script detects on its own which host devices (`/dev/sda`, `/dev/mmcblk0`, etc. - edit the `DEVICES` list at the top of the script if yours are different) actually support SMART, and ignores the ones that don't (common on an SD card/eMMC).

## Troubleshooting

- **`pi-dashboard-api` container never becomes "healthy"**: `docker compose logs pi-dashboard-api` - the most common cause is a wrong `DOCKER_GID` in `.env` (the process can't talk to `/var/run/docker.sock`).
- **Screen stays blank/JS doesn't update after a `git pull` + rebuild**: `web/nginx.conf` marks `index.html` and every file under `src/` as `Cache-Control: no-cache`, and `auth.js`/`style.css` are requested with a `?v=` query string that changes on every asset edit - together those should stop any cache from serving a stale copy after a rebuild. On some network paths (a caching proxy in the middle) a stale copy can still stick around anyway; a hard refresh usually fixes it. If it doesn't, the problem is outside the dashboard's control (a network/carrier-level cache), not something wrong with the deploy.
- **`docker-compose.override.yml` turned into a folder instead of a file**: you skipped step 2. Stop the containers, `docker compose down`, `rm -rf docker-compose.override.yml`, `touch docker-compose.override.yml`, bring it back up.
