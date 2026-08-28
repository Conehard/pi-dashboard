FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# docker-cli + the compose v2 plugin, used by actions/composeActions.js to
# shell out to `docker compose` for project-level pull/up/down and to
# validate edited compose files (`docker compose config -q`). Talks to the
# same /var/run/docker.sock already mounted for dockerode - no extra socket
# or daemon needed.
RUN apk add --no-cache docker-cli docker-cli-compose

COPY package.json package-lock.json ./
# better-sqlite3 is pinned to 11.10.0 (package.json), not whatever is
# latest - v13.x's bundled prebuilt binary for linux-musl/arm64 (this exact
# platform) segfaults on load here, confirmed by hand. Forcing a from-source
# compile of v13 doesn't help either (same crash) - something in that
# version's native code itself doesn't work right on this Alpine/Node/arch
# combination, LTO or not. v11.10.0's prebuild loads and works fine, so
# that's what's actually installed - no build tools needed here as long as
# the pin stays in place. If better-sqlite3 ever gets bumped again, re-test
# on real hardware before trusting it (`node -e "require('better-sqlite3')"`
# inside the built image) - a segfault like this doesn't show up any other
# way until it crashes the running dashboard.
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

# /data is where the pi-dashboard-data named volume gets mounted - the
# app's own SQLite database (db.js) lives there. A fresh named volume is
# initialized by Docker from whatever's at that path in the image,
# ownership included - so creating it here as 'node' means the volume
# comes up writable by the non-root user below, instead of the root:root a
# bare mount point would otherwise get.
RUN mkdir -p /data && chown node:node /data

EXPOSE 3000

# node:alpine already ships busybox wget, no extra package needed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

# Runs as the built-in non-root 'node' user (uid 1000). Docker socket read
# access for this user is granted via the 'group_add' entry in compose,
# not by running as root here.
USER node

CMD ["node", "src/server.js"]
