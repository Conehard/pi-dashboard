# Two stages: the first only exists to run Tailwind (needs Node + the
# devDependencies in package.json) and produce style.css - the final image
# is still pure nginx, nothing from this stage except that one generated
# file makes it in. This replaces what used to be a manual
# `npm run build:css` step a person had to remember to run before every
# `docker compose build` (a documented footgun: forgetting it silently
# shipped stale CSS) - now `docker compose up -d --build` alone always
# produces current CSS.
FROM node:20-alpine AS css-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
# input.css's @source directives point at ../index.html and ../auth.js
# (relative to src/) to scan those two files for Tailwind classes, same as
# it would sitting next to them outside Docker - so both need to land
# right here as siblings of src/, not just inside the final nginx image
# below. Without them, Tailwind's content scan silently drops every
# utility class used only in index.html/auth.js (never referenced from
# src/**/*.js) - no build error, just missing CSS rules in the shipped
# style.css (confirmed by hand: a stray `.flex` used raw in index.html's
# sidebar markup rendered unstyled in the built image while matching
# perfectly in a local `npm run build:css`).
COPY index.html auth.js ./
COPY src ./src
RUN npm run build:css

# nginx-unprivileged: same nginx:alpine base, but pre-configured to run as
# a non-root user (uid 101) and listen on an unprivileged port (8080).
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html auth.js /usr/share/nginx/html/
COPY src /usr/share/nginx/html/src
COPY --from=css-build /build/style.css /usr/share/nginx/html/style.css

# index.html/auth.js reference style.css and auth.js's own dynamic app.js
# import with a __ASSET_VERSION__ placeholder (see the ?v= cache-busting
# comment in nginx.conf) instead of a hand-typed date string someone had to
# remember to bump on every deploy - stamped here with the actual build
# time instead, so every `docker compose up -d --build` that picks up a
# real change to these files automatically busts caches on its own. Needs
# root: the COPY above left these files root-owned, and this base image
# already runs as the unprivileged 'nginx' user (uid 101) by default -
# confirmed by hand, sed's atomic rewrite (a temp file next to the
# original) fails with "Permission denied" otherwise. Switches back right
# after so the container still runs unprivileged, same as the base image
# intends.
USER root
RUN sed -i "s/__ASSET_VERSION__/$(date +%Y%m%d%H%M%S)/g" \
  /usr/share/nginx/html/index.html /usr/share/nginx/html/auth.js
USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ || exit 1
