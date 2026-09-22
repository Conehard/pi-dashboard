# Plan: Tuya device management panel

Status: **v1 and v2 both shipped and deployed** (`docker compose up -d --build` run for real on
2026-09-14, twice - once for v1, again for v2). Phases 0-9 are v1. Real usage of v1 turned up UX/scope
gaps (smaller cards + modal editing, confusing labels, a door sensor that "didn't update", an event
snapshot blob overflowing a card, offline devices cluttering the list, camera viewing, per-device
refresh, automations) - **Phases 10-14** are that v2 work, per the user's "pode fazer tudo" go-ahead.
See each phase below for what's actually verified vs. what could only be verified structurally (a real
constraint around concurrent Tuya API calls, discovered mid-session, limited how much of Phase 13/14
could be safely live-tested - see the "Important constraint" note before Phase 14's open questions).

Decisions locked in with the user on 2026-09-14, for v1:

- **Integration mode: hybrid.** Tuya Cloud API (developer.tuya.com) is used only for setup - linking the
  user's Tuya/Smart Life app account, discovering devices, and pulling each device's `local_key` + DPS
  schema. Day-to-day control (on/off and everything else) goes over the LAN directly to the device,
  falling back to the Cloud API's device-commands endpoint when the device isn't reachable locally.
- **Scope: full control**, not just on/off - per-device controls driven by that device's real DPS schema
  (brightness/color/temperature/etc, not just a switch), with a generic fallback for anything not
  specifically modeled.
- **Device count: 6+, mixed types** (not just sockets/switches) - category/type-aware UI grouping matters
  from the start, not a "add it later" concern.

This file is the working checklist for the implementation - check items off as they're done. If a session
gets interrupted mid-work, this file (not conversation memory) is the source of truth for what's left.

## Phase 0 - Account setup (user-side, outside this repo)

- [x] Create a Tuya IoT Platform account + a "Cloud Development" project - Client ID/Secret + project
      code received 2026-09-14 (kept out of the repo - see Phase 2/4 for where they end up persisted).
- [ ] **Currently blocked here:** the project already shows **IoT Core** (plus Authorization Token
      Management, Smart Home Basic Service, Data Dashboard Service) as "Authorized" under Service API -
      so it's not a missing subscription. "Authorized" on that list only means permission was granted at
      some point, not that the trial is currently active - Tuya's free IoT Core trial is time-limited
      (commonly monthly) and has to be **manually extended**, separately from the one-time authorization,
      which is almost certainly what's actually happening here given the exact error text. Fix: **Cloud**
      → **Cloud Services** (not Development) → open **IoT Core** → **My Subscriptions** tab →
      **Subscribed Resources** → find the IoT Core row for this project/data center → **Extend Trial
      Period**. Tuya says approval takes 1-2 business days - not instant, so this step has a real wait
      attached to it. Once approved, re-run the Phase 1 test script to confirm `listDevices()` stops
      erroring.
- [ ] Once subscribed, figure out (from the console, not from region-guessing) which of the 4 data
      centers this project actually lives in - the token call succeeding in us/eu/in equally suggests
      token issuance doesn't validate the region, only the real business calls will actually pin it down.
- [ ] Link the Tuya Smart / Smart Life app account to the Cloud Development project (App Account →
      Link Tuya App Account, scan the QR code from the phone that has the real devices in it) - without
      this step the Cloud API sees zero devices, even with correct credentials and a subscribed service.
- [ ] Confirm all 6+ real devices show up under Devices → Link Devices in the Tuya IoT Platform console
      before writing any more code against them - catches app-account linking problems early, independent
      of anything in this repo.

## Phase 1 - Backend: Tuya Cloud API client

`api/src/features/tuya/cloud.js` - **implemented**, confirmed against the official docs (not memory -
verified live via developer.tuya.com on 2026-09-14, since endpoint names/versions do change):

- [x] Request-signing (`client_id [+ access_token] + t + nonce + stringToSign`, HMAC-SHA256, uppercased)
      and token management (`GET /v1.0/token?grant_type=1`, cached in memory, refreshed ~60s before the
      ~2h expiry) - self-implemented over plain `fetch`, no official connector package, same style as
      `notifications/telegram.js` calling the Telegram HTTP API directly.
      **Live-tested**: token retrieval succeeds against the real account in all 4 regions.
- [x] `listDevices()` - `GET /v2.0/cloud/thing/device` (paginated, `page_size`/`last_id`). Turned out to
      already return `localKey` + `category` + `ip` per device in the same call, so there's no separate
      "get local key" request needed (simpler than the original plan below).
      **Blocked from a real result** by the Phase 0 "data center suspended" issue - code path itself
      matches the documented request/response shape.
- [x] `getDeviceSchema(deviceId)` - `GET /v1.0/iot-03/devices/{id}/specification` → `{ functions, status }`,
      the DPS schema (code/type/values per data point) that drives Phase 7's per-type UI. Not yet
      live-tested (blocked by the same Phase 0 issue).
- [x] `sendCommand(deviceId, commands)` - `POST /v1.0/iot-03/devices/{id}/commands`,
      `{ commands: [{ code, value }] }` - the LAN-fallback path for Phase 3. Not yet live-tested.
- [x] Region/base-URL handling for the four Tuya data centers (`openapi.tuyaus.com` / `tuyaeu.com` /
      `tuyacn.com` / `tuyain.com`) - `cn` failed to even connect from this host during testing (likely
      network-level, not credential-related - not a blocker since the account isn't in that region).
- [x] **Fully live-tested against the real account (2026-09-14)**, all 14 real devices came back once
      the app account was linked to the correct data center (`us` - see Phase 0). `getDeviceSchema` also
      confirmed live against 4 different categories. Real-world details that affect Phase 7's UI and
      weren't guessable up front:
  - `functions[].type`/`status[].type` come back **capitalized** (`"Boolean"`, `"Integer"`, `"Enum"`,
    `"String"`) - not the lowercase `bool`/`value`/`enum`/`string` this plan originally assumed.
  - `functions[].values` (and `desc`, which duplicates it) is a **JSON-encoded string**, not an object -
    e.g. `"{\"unit\":\"s\",\"min\":0,\"max\":86400,\"step\":1}"` for an Integer, `"{\"range\":[...]}"`
    for an Enum, `"{}"` for a Boolean. Must `JSON.parse` it before reading `min`/`max`/`range`/etc.
  - `functions[].name` comes back **in Chinese** for this account (e.g. `开关` for a switch's `code:
    "switch_1"`), not localized - the Cloud API doesn't appear to auto-translate function names.
    Phase 7 shouldn't render `name` directly; build a small static `code → Portuguese label` dictionary
    for well-known standard codes (`switch_1`, `switch_led`, `bright_value`, `countdown_1`, ...) and
    fall back to showing the raw `code` for anything not in it.
  - A Zigbee gateway device itself (category `wg2`, "Hub Zigbee" here) comes back with **empty
    `functions`/`status`** - it's not directly controllable, only its sub-devices are (over the cloud
    path, since sub-devices never carry their own `local_key` - see the `listDevices` note below). Show
    it as a status-only card (online/offline), no control section.
- [x] `listDevices()` real-world shape confirmed: of this account's 14 devices, **9 had a real
      `localKey`** (cameras, a light strip, the Zigbee hub, an intercom) and **5 came back with
      `localKey: ""`/`ip: null`** (3 Zigbee door/window/temperature sensors, a Zigbee switch, 2 Zigbee
      plugs) - all of them Zigbee sub-devices of the Hub Zigbee gateway, which don't get their own LAN
      key/IP. This is exactly what the hybrid design already handles for free: no local key → Phase 3's
      local client is simply never attempted for these, they always take the cloud-command path. No
      special-casing needed elsewhere, just don't treat an empty `localKey` as an error.
- [x] Decided with the user: the 4 `sp` (camera)-category devices **are in scope** - shown like any other
      device, controlled via whatever DPS the schema exposes (e.g. on/off, motion-detection toggle) -
      **no video/streaming**, that's a fundamentally different protocol and stays out of this panel.

## Phase 2 - Backend: persistence ✅ done

`api/src/features/tuya/store.js` (no changes needed to `lib/db.js` itself - like every other feature,
the tables are created via `db.exec` inside this module on import, same as `notifications/store.js`).

- [x] `tuya_config` table - singleton row, same pattern as `notification_bot`, secret encrypted via
      `lib/crypto/secret-box.js`, never redisplayed (only `getConfigSummary()`'s masked
      `clientIdPreview` goes to the browser - `getDecryptedConfig()` is internal-only, for `cloud.js`).
- [x] `tuya_devices` table, with one deliberate nuance found while building it: the upsert used by a
      cloud sync (`upsertDeviceFromCloud`) only ever touches `name`/`category`/`product_id`/
      `local_key_encrypted`/`dps_schema` - it does **not** overwrite `ip`/`protocol_version`/`online`/
      `last_seen_at`, which are exclusively owned by Phase 3's poller (`updateDeviceRuntime`) so a
      manual "sync devices" click can't stomp on live state a concurrent poll tick just wrote.
- [x] CRUD surface: `isConfigured`, `getConfigSummary`, `getDecryptedConfig`, `saveConfig`, `clearConfig`
      (also wipes every device - their secrets belong to the account being removed), `listDevices`
      (`{ includeHidden }`), `getDevice`, `getDecryptedLocalKey`, `upsertDeviceFromCloud`,
      `updateDeviceRuntime`, `renameDevice`, `setDeviceHidden`, `removeDevice`.
- [x] Audit log entries via `features/audit/audit.js`: `tuya.config.save`/`.remove`,
      `tuya.device.rename`/`.hide`/`.unhide`/`.remove` - matches the Docker/compose actions' convention.
      (Sync and command-send audit entries land in Phase 4, where those actions actually happen.)
- [x] Smoke-tested end-to-end against a throwaway SQLite file (config save/read/clear, device
      upsert/runtime-update/rename/hide/remove, encryption round-trip) - all passed.

## Phase 3 - Backend: local (LAN) control + status polling ✅ done (redesigned mid-implementation)

`api/src/features/tuya/local.js`, `api/src/features/tuya/poller.js` - **major design change from what
this section originally said**, forced by a real constraint discovered while implementing it:

**Why local *control* was dropped** (kept local for reads only): Tuya's LAN protocol addresses every
data point by a **numeric index** (`{"1": true}`), but confirmed live against this account, the Cloud
API never returns that number - `GET /v1.0/devices/{id}`'s `status` array only ever has `{code, value}`,
no `dp_id`, contradicting what search results suggested. `tinytuya`'s own docs confirm this is a known
gap: the real mapping only shows up after manually enabling "DP Instruction" mode per-device in the Tuya
console, which itself takes 12-24h to propagate and still doesn't cover every product. Sending a raw
local command without that mapping risks tripping the wrong function on a physical device - decided with
the user to not take that risk. **Resolution**: `local.js` only ever probes reachability (`connect()`
succeeding = online), never calls `set()`. Every real control command goes through `cloud.sendCommand()`
(Phase 4's `POST /api/tuya/devices/:id/command`), which addresses DPS by `code` and is always correct.

- [x] `tuyapi` added to `api/package.json` (`^7.7.1`) - zero vulnerabilities of its own; `npm audit`
      flags 4 pre-existing ones in `js-yaml`/`express`'s `qs`, unrelated to this change, left alone.
- [x] `features/tuya/local.js`'s `probe(device, localKey)` - connect-only reachability check, **live
      -tested from the Pi itself** (this environment runs on the actual host, same LAN as the devices):
      Hub Zigbee found via UDP broadcast + connected in 669ms; a cached-IP reconnect took 5ms; an
      offline device correctly timed out after the full 6s window; all 4 cameras and every Zigbee
      sub-device correctly short-circuited to `supported: false` with **zero** network calls (cameras
      never answer the classic LAN protocol at all - confirmed live, `find()` just times out for them
      every time; Zigbee sub-devices have no `local_key` of their own to probe with in the first place).
- [x] `features/tuya/poller.js` - two independent `setInterval` cadences (same pattern as
      `features/system/miner.js`), both **live-tested end-to-end against all 16 real devices**:
  - **Local tick** (`TUYA_LOCAL_POLL_INTERVAL_MS`, default 20s): runs `local.js`'s `probe()` for every
    device that has one, writes `online`/`ip`/`protocol_version` to `tuya_devices` - this is the *only*
    thing that still touches the LAN/`store.updateDeviceRuntime` for those devices.
  - **Cloud tick** (`TUYA_CLOUD_POLL_INTERVAL_MS`, default 60s): **one** `GET
    /v1.0/iot-03/devices/status` call refreshes DPS values (labeled by code) for the whole account at
    once (confirmed live: all 16 devices' full status in a single request, well under the 20-id page
    limit - `cloud.getBulkStatus`, paginates automatically past 20 if the account grows), cached
    in-memory (`getCachedDps(id)`, not persisted to SQLite - it changes far too often to be worth it).
    A second call, `GET /v2.0/cloud/thing/batch` (`cloud.getBulkOnlineStatus`), supplies the `online`
    flag **only** for devices the local tick can't reach itself (cameras, Zigbee sub-devices) - real
    devices with a local key never have their online flag overwritten by this call.
- [x] **Real-world caveat surfaced by the live test, worth remembering for Phase 7's UI**: Tuya's cloud
      `is_online` reads as `false` for battery-powered Zigbee sensors (door contacts, the temp/humidity
      sensor) most of the time even though they're clearly alive and reporting fresh values (their DPS
      cache updates normally) - they sleep between reports, which the cloud's connectivity flag reflects
      literally. Phase 7 should probably lean on "has a recent DPS value" (`lastSeenAt`/the poller's
      `updatedAt`) rather than a strict online/offline dot for that category, or the UI will look like
      half the sensors are broken when they're actually fine.
- [ ] Skipped for now (not decided against, just not needed yet): a `tuya_device_offline` notification
      event type - revisit once the "online means what, exactly" question above is settled for real
      devices, otherwise it would misfire constantly on the battery sensors.
- [x] `server.js` wiring (`import { startTuyaPoller } from ...` + calling it in the `app.listen`
      callback, same line as `startMinerPoller()` etc.) - done in Phase 4, alongside mounting the
      actual routes, so the poller doesn't start running against a route-less feature.

## Phase 4 - Backend: routes ✅ done

`api/src/routes/tuya.routes.js`, wired into `server.js` behind `requireAuth`, mounted at `/api/tuya`,
`startTuyaPoller()` called alongside the other pollers in the `app.listen` callback - all matching the
existing route group conventions exactly.

- [x] `GET /api/tuya/status` - `{ configured, region, clientIdPreview, configuredAt, regions,
      deviceCount }`. `regions` is `Object.keys(cloud.REGIONS)` - the frontend's Settings region picker
      reads the valid list from here instead of hardcoding it, so a new data center Tuya adds later only
      needs a `cloud.js` change, not a frontend one too (see the "genérico" note below).
- [x] `POST /api/tuya/config` - validates against the real Cloud API (`cloud.validateCredentials`, a
      real token request) before saving; `400` on missing `clientId`/`clientSecret` or an unknown
      `region`. **Live-tested via a real HTTP call** against a throwaway Docker container (see below)
      with the real account's credentials - saved correctly, `clientIdPreview` masked as expected.
      **Changed after deploy, per the user**: originally required `currentPassword` too (matching the
      Telegram bot token's pattern), but removed for this route specifically - there's only one
      dashboard user and the session's already authenticated, so it was pure friction with no real
      second factor behind it. `DELETE /api/tuya/config` below kept the password gate, since
      unregistering the whole account + every device is the more destructive side.
- [x] `DELETE /api/tuya/config` - `currentPassword` gate; `store.clearConfig()` also wipes every
      registered device (decided: local-only records tied to an account being removed, not worth keeping
      as orphaned state - a re-sync after reconfiguring rebuilds them anyway).
- [x] `POST /api/tuya/sync` - `cloud.listDevices` + per-device `cloud.getDeviceSchema`, upserts via
      `store.upsertDeviceFromCloud`. A single device's schema call failing is logged and skipped, not
      fatal to the whole sync (registered with an empty schema instead - Phase 7's generic fallback
      still covers it). **Live-tested**: real call against the account added all 16 real devices in one
      run (`{ added: 16, updated: 0, total: 16 }`, ~4.7s).
- [x] `GET /api/tuya/devices` - `store.listDevices()` merged with `poller.getCachedDps()` per device
      (`dps`, `dpsUpdatedAt`). `?includeHidden=1` to also list hidden ones (Settings/management use).
- [x] `POST /api/tuya/devices/:id/command` - body `{ code, value }` or `{ commands: [{code,value}, ...] }`
      - one generic endpoint, always via `cloud.sendCommand` (see Phase 3's redesign note - never local).
      **Route logic live-tested** (404 on unknown device, 400 on an empty body) - the actual Tuya call
      itself was deliberately **not** fired against a real device during testing, to avoid flipping real
      hardware (a camera, a light) without the user watching. Worth a real end-to-end confirmation later.
- [x] `PUT /api/tuya/devices/:id` - `{ name?, hidden? }`, local-only. **Live-tested**: renamed and
      hid/unhid a real device record, confirmed it disappears from the default list and reappears with
      `?includeHidden=1`.
- [x] `DELETE /api/tuya/devices/:id` - unregisters locally only.
- [x] **i18n**: every new user-facing validation error uses an `err.*` key in both `en.json`/`pt.json`
      (`err.tuyaInvalidRegion`, `err.tuyaUnreachable`, `err.tuyaRejected`,
      `err.tuyaClientIdSecretRequired`, `err.tuyaRegionRequired`, `err.tuyaNotConfigured`,
      `err.tuyaDeviceNotFound`, `err.tuyaCommandRequired`) rather than a hardcoded Portuguese string,
      matching `errorHandler`'s `t(req.lang, err.message, err.vars)` convention - important since this
      is an open-source project other deployers will run in English. `store.js`'s empty-name check
      reuses the existing `err.nameRequired` key instead of duplicating it.
- [x] **Verification method**: `docker build` of the real `api/Dockerfile` (Node 20, matching
      production - the host itself runs Node 24, which turned out to crash `better-sqlite3` on process
      cleanup in ad-hoc host-node testing; irrelevant once tested the real way) into a throwaway image,
      run as a **standalone container on a scratch port/volume** (never via `docker compose`, so the
      live `pi-dashboard-api`/`pi-dashboard-web` containers - up 6 weeks - were never touched), exercised
      with real `curl` calls including real Tuya credentials, then removed.
- [x] **Pre-existing bug found, unrelated to Tuya** (confirmed via `git stash` - reproduces on
      unmodified `main` too): booting against a genuinely **empty/fresh** database throws `SqliteError:
      no such table: main.uptime_targets` from `features/uptime/checks.js`, because
      `features/uptime/targets.js` imports `checks.js` at its own top *before* running its own `CREATE
      TABLE uptime_targets` - some earlier-imported module's top-level code appears to touch
      `uptime_targets` through that path before it exists. Never surfaces on a real long-lived
      install (the table's already there from before), only on a brand new one - worth a fresh-install
      test/fix outside this Tuya task. Worked around for this session's own testing by pre-seeding the
      table by hand; the real project code was not touched to work around it.

## Phase 5 - Frontend: new screen ✅ done

`web/src/views/tuya/view.js` + `template.html`, `core/router.js`, `app.js`, `index.html`, sidebar.

- [x] `#tuya` registered in `core/router.js`'s `VIEWS` list, `<pd-view-tuya>` added to `index.html`
      (right before `<pd-view-settings>`), `views/tuya/view.js` imported from `app.js`, sidebar link
      added between Internet and Settings with its own icon.
- [x] **Important correction to this plan's own assumption**: this codebase turned out to already have
      a full working i18n system for the frontend too (`core/i18n.js`, `web/src/i18n/{en,pt}.json`,
      `data-i18n*` attributes) - contrary to `docs/ARCHITECTURE.md`'s current claim that "the UI itself
      wasn't translated". Every new on-screen string (nav label, headings, buttons, messages) was added
      to **both** `en.json` and `pt.json` under `nav.tuya`/`tuya.*`/`settings.tuya.*` (403 keys each,
      verified with a script that the two files' key sets are identical) instead of being hardcoded
      Portuguese - the "genérico" instruction the user gave applies here too, not just to the backend.
      `docs/ARCHITECTURE.md`'s stale claim should get corrected in Phase 8.
- [x] Polls `GET /api/tuya/devices` every 10s (`POLL_INTERVAL_MS`) while mounted, same idea as
      Docker/Tasks's own polling.

## Phase 6 - Frontend: Settings panel ✅ done

`web/src/views/settings/template.html` (`#tuya-panel`, inserted right after the Notifications panel) +
`web/src/views/settings/view.js` - copies the Telegram bot panel's exact shape (status row with
Change/Remove buttons ↔ empty form, reveal-secret button, current-password gate on every write).

- [x] Form: Client ID, Client Secret (password-type input with a reveal toggle, never pre-filled),
      **region `<select>` populated at runtime from `GET /api/tuya/status`'s `regions` array** - not
      hardcoded in the HTML, so a new Tuya data center added later needs only a `cloud.js` change (see
      the "genérico" note in Phase 4). "Save" calls `POST /api/tuya/config`.
  - **Live-tested through the real nginx proxy** (see Phase 4's Docker-based method, extended to a
    paired throwaway `api`+`web` stack on an isolated network/port - never the live containers): login
    → save real credentials → sync → device list, all through the same path a browser actually uses.
- [x] Status line once configured: `settings.tuya.connectedStatus` (region + masked client ID + device
      count), "Change credentials" reopens the form empty, "Remove" prompts for the current password
      like the bot token's removal does.
- [x] "Sync devices now" button → `POST /api/tuya/sync`, result shown via `showActionResult` with the
      added/updated/total counts.

## Phase 7 - Frontend: device cards (schema-driven controls) ✅ done

`web/src/views/tuya/view.js` - every control is generated from that specific device's own schema, no
per-category hardcoding anywhere in the renderer itself (only two small, clearly-fallback-guarded
readability dictionaries - see below).

- [x] Devices grouped into a `.panel` section per `category`, sorted alphabetically by that category's
      label; each device is its own `.panel` card (name, category, rename/hide/unregister buttons -
      matches the Status screen's per-target card layout almost exactly).
- [x] Status dot **follows Phase 3's real-world finding**, not a naive online/offline flag: a device
      with its own local key (and not a camera) shows the real local-probe online/offline; everything
      else (cameras, Zigbee sub-devices) shows "data updated {when}" with a freshness-based dot instead
      of a flag that would read as broken for battery sensors that just sleep between reports.
- [x] Per-DPS-type control, driven entirely by `type`/`values` from the live schema (confirmed live
      against the real account - `values` needed `JSON.parse`, `type` comes back capitalized
      `Boolean`/`Integer`/`Enum`/`String`, not the lowercase this plan originally guessed - see Phase 1):
      `Boolean` → the existing `.switch` toggle, `Integer` with a `min`/`max` → a range slider (scaled/
      unit-aware, e.g. `scale: 1` cents→a real number, `unit: "s"`), `Enum` with a `range` → a `<select>`,
      anything else (`String`, or a type with no usable min/max/range) → a generic text field + explicit
      Send button - covers a device type this codebase has never seen without hiding its controls.
  - Read-only DPS (present in `status` but not in `functions` - sensor readings, energy metrics,
    firmware-internal fields) render as plain info chips under a separate "Readings" heading, never as
    an editable control.
- [x] **Optimistic UI**: a toggle/slider/select's visible value is the one the user just set - Phase 4's
      route deliberately doesn't wait for a re-poll before responding, and the frontend deliberately
      does **not** immediately refetch after a successful command either (the cloud poll cache can be up
      to ~60s stale right after a change - refetching immediately would flash back to the old value and
      look like the click failed). On a failed command, the control **does** revert to its prior value
      and shows `tuya.commandFailed`.
- [x] Two small **readability dictionaries**, not architecture: `DP_LABELS` (code → plain-English label,
      e.g. `switch_led` → "Switch") and `CATEGORY_LABELS` (`cz` → "Sockets") in `view.js`, both with a
      graceful fallback (`Title Case` of the raw code, or the raw uppercased category) for anything not
      listed - covers the standard codes seen live on this account plus other common ones, never a hard
      requirement for a device/category to work. Deliberately **not** routed through the `en.json`/
      `pt.json` i18n system (unlike every actual UI string) - these labels describe vendor-defined
      device data (closer to a container's env var name than to app chrome), and Tuya has far too many
      product categories/DPS codes for a translated dictionary to ever be complete anyway.
- [x] **CSS**: `web/src/input.css` got ~10 new `.tuya-*` classes (category headings, control rows, the
      range input, the read-only "Readings" chip row) - compiled cleanly with `npx tailwindcss` (also
      confirmed as part of the real multi-stage `web/Dockerfile` build, not just standalone).

## Phase 8 - Docs ✅ done

- [x] `docs/ARCHITECTURE.md` - new "Tuya devices" `##` section (between Status/Uptime and Database),
      covering the hybrid model (cloud for control+values, local for reachability only - and *why*,
      since that's the opposite of this plan's original assumption), the poller's two cadences, the
      Zigbee-sub-device "online looks pessimistic" quirk, the schema-driven control approach, and the
      real setup pitfalls hit this session (the `28841107` red herring, the data-center-for-the-app-
      account-link gotcha). Also fixed two small **pre-existing** staleness issues found while touching
      this file (not related to Tuya, just adjacent): the "UI isn't translated" claim was wrong (a full
      `core/i18n.js` + `en.json`/`pt.json` system already exists), and the hash-route bullet list was
      missing `#internet` - both corrected in passing since they were right next to what this phase was
      already editing.
- [x] `INSTALL.md` - new numbered "7. Tuya devices (optional)" section, same style as the SMART/
      Tailscale/etc. "Optional host integrations" section, with the exact console steps (Cloud
      Development project → link the Tuya app account with the *matching* data center → dashboard
      Settings → Sync) and the same `28841107` warning from ARCHITECTURE.md.
- [x] `api/package.json` - `tuyapi` dependency (already added and verified in Phase 3).

## Phase 9 - Validation

- [x] **Backend, end-to-end, against the real account**: every route live-tested via `curl` through a
      throwaway `docker build`ed API container (real Node 20/Alpine, matching production) - config
      save/validate, sync (16 real devices), device list with live DPS, rename, hide/unhide + filtering,
      404/400 validation paths. Never touched the live `pi-dashboard-api`/`pi-dashboard-web` containers
      (checked before and after - still "Up 6 weeks, healthy").
- [x] **Frontend, end-to-end, through the real nginx proxy**: a paired throwaway `api`+`web` stack on an
      isolated Docker network (so the proxy's hardcoded `pi-dashboard-api` hostname resolves exactly
      like production), the real multi-stage `web/Dockerfile` Tailwind build (confirmed the new
      `.tuya-*` classes compile), static files (`view.js`/`template.html`) confirmed served, full
      login → configure → sync → device-list-with-live-DPS flow confirmed through that same proxy path.
      Every `getElementById`/`querySelector` id referenced in the new `view.js` files cross-checked
      against their `template.html` by script - no mismatches.
- [x] Schema-driven rendering logic **exercised against real varied schemas** (Boolean/Integer/Enum from
      4 different real device categories - light strip, dimmer switch, 2-gang switch), confirming the
      renderer branches correctly, not just a happy-path toggle - see Phase 1/7's notes on the real
      `type`/`values` shapes found.
- [x] **Real browser confirmation, superseded by the real thing**: no `claude-in-chrome` session was
      ever connected, but this stopped mattering once v1 was actually deployed (`docker compose up -d
      --build`, see below) and the user opened it in their own real browser - that's strictly better
      confirmation than a connected automation session would have given, and it's exactly what surfaced
      every real gap Phases 10-14 exist to fix (see the top of this file).
- [x] **Real device command, confirmed** - the user tested v1 for real (toggles, the door sensor), which
      is how Phase 10's "sensor didn't update" finding and the rest of this v2 round happened. The
      original caution about not flipping hardware without the user watching was about *this session*
      not doing it unprompted - once deployed, the user doing exactly that themselves is the intended
      path, not a gap.
- [x] **Real deploy, done twice**: `docker compose up -d --build` was run for real against the live
      `pi-dashboard-api`/`pi-dashboard-web` containers - once for v1, once again after v2's Phase 10-14
      changes. Both times the new tables (`CREATE TABLE IF NOT EXISTS`, same as every other table in
      this codebase) added cleanly to the existing, already-populated database - no migration step
      needed, and the pre-existing `uptime_targets` ordering bug (Phase 4) never triggered on either
      deploy, exactly as predicted (it only reproduces against a truly empty/fresh database).

## Open questions to settle before/at Phase 1

- Exact Cloud API endpoints differ slightly by Tuya API version (`v1.0` vs `v1.1`/`v2.0` "iot-03"); pin
  down the current recommended ones from developer.tuya.com's docs at implementation time rather than
  trusting endpoint names written here from memory - Tuya has renamed/versioned these before.
- Whether "remove device" (Phase 4) should also revoke it cloud-side or purely stop tracking it locally -
  leaning local-only (safer, reversible via another Sync) but confirm during Phase 4.

---

# v2 - real-usage feedback (2026-09-14, after v1 went live)

After deploying v1 and using it for real, the user reported (verbatim, translated from the original
Portuguese feedback): the `#tuya` screen's usability is bad and cards should be smaller with editing in
per-card modals; each function's label/explanation reads oddly; testing a door sensor by opening/closing
it physically didn't update on screen; an "event snapshot" field is overflowing/leaking out of a card's
body; offline devices should be hideable and hidden **by default**; camera viewing should be possible;
each device should be refreshable individually; and there should be a way to build routines/automations
(example given: door sensor opens → turn something on, or fire a notification).

Two decisions locked in with the user for this round (2026-09-14):

- **Cameras: periodic snapshot/thumbnail first**, not full live video. Tuya cameras speak a proprietary
  P2P protocol for real streaming - turning that into something a `<video>` tag can play would need a
  bridging service of its own (its own container, likely). A snapshot avoids that entirely: the Cloud
  API can trigger the camera to capture a still image and hand back a URL for it.
- **Automations: actions are "send a Tuya command to another device" and/or "send a Telegram message"**
  - covers both examples the user gave (turn something on / fire a notification) without inventing a
    third action type.

## Phase 10 - Quick fixes (small, low-risk, no open design questions - do these first)

- [x] **"Event snapshot" field leaking out of the card body.** Root cause: `renderReadings()` in
      `views/tuya/view.js` renders *every* status-only DPS as a chip, with no size guard - codes like
      `movement_detect_pic`/`alarm_message`/`initiative_message`/`doorbell_pic` are base64-encoded JSON
      blobs, sometimes multiple KB, seen live on this account's own cameras/intercom (see Phase 1's raw
      `getBulkStatus` dump earlier in this file for real examples). Fix in two layers, not one, so a
      value that slips past the filter still can't break the layout:
  1. Filter out any status value that's clearly not a human reading before rendering it at all -
     generically, by **length** (e.g. any string over ~120 chars), not by hardcoding these specific
     field names - keeps it working for whatever other huge/internal fields a device this codebase
     hasn't seen yet might report, not just the ones seen on this account.
  2. CSS safety net regardless: the `.tuya-readings` chip row should `overflow: hidden`/`text-overflow:
     ellipsis` with a `max-width` per chip either way, so even a filter miss can't blow out the card.
- [x] **Confusing per-function labels.** A few concrete problems to fix, not just "make it nicer":
  - **Enum/status *values* were never translated**, only the DPS *code* was (`dpLabel()` exists,
    nothing plays the same role for a value like `"power_off"`/`"last"` or a raw `"0"`/`"1"`/`"2"`
    enum). Add a small `VALUE_LABELS` dictionary (same shape/spirit as `DP_LABELS` - a modest curated
    set, generic fallback to the raw value formatted the same way `dpLabel()` falls back for an unknown
    code) so a control/reading shows "Last state" instead of `"last"`.
  - **No visual hierarchy** - a device with 6 functions shows 6 identical-looking rows, so the one that
    actually matters (the main switch) doesn't stand out from `switch_type`/`switch_inching`/
    `relay_status` (power-on behavior, rarely touched day to day). Phase 11's modal redesign is where
    this really gets fixed (primary control on the card, everything else behind "Advanced" in the
    modal), but do the boring is-this-DPS-actually-a-primary-control heuristic here since Phase 11
    needs it too: a function counts as "primary" if its code is `switch`, `switch_1`, or `switch_led`
    (the overwhelmingly common single-primary-function convention - confirmed live on this account's
    own sockets/switches/lights), everything else is "secondary".
- [x] **Why the door sensor "didn't update"** - not actually a bug, but a real, worth-fixing latency
      problem: "Porta do escritório" is a Zigbee sub-device (no `local_key` - see Phase 3), so its DPS
      value depends *entirely* on Tuya's cloud (sensor → Zigbee mesh → gateway → Tuya cloud, then this
      dashboard's own 60s cloud-tick cache on top). Testing it by hand and checking the screen 10-20s
      later will very plausibly still show the old value - that's not broken, it's genuinely the current
      round-trip. Two-part fix:
  1. Drop the default `TUYA_CLOUD_POLL_INTERVAL_MS` from 60s to **30s** - still one cheap bulk call
     covering every device, trivially inside the free tier (2,880 calls/day at this account's size, not
     thousands), meaningfully shortens the worst case.
  2. Phase 12 (per-device manual refresh) is the real answer for "I just did something, show me now" -
     link the two in the UI (e.g. the door sensor's card, once made real in Phase 11, gets the same
     manual-refresh button every other device gets, not a sensor-specific thing).
- [x] **Offline devices hidden by default.** New "hide offline" checkbox next to the existing "show
      hidden" one in `#tuya`'s toolbar, **defaulting to checked** (opposite default from "show hidden"),
      persisted in `localStorage` the same way `settings/view.js`'s `CARD_PREF_KEY` already does for
      Overview's card toggles - a per-browser display preference, not application state, so it doesn't
      need a new API field. "Offline" for this filter reuses `statusInfo()`'s existing dot logic
      (`dot-error` for a LAN-capable device that's actually unreachable, or `dot-unknown` for a
      cloud-only device with no recent data) rather than inventing a second definition of online/offline.

## Phase 11 - Card/modal UX redesign

- [x] **New reusable modal primitive** - nothing like this exists anywhere in the codebase yet (checked:
      no `<dialog>`, no custom modal component in any screen). Add `core/modal.js` using the native
      `<dialog>` element (`showModal()`/`close()`, built-in focus trap + Escape-to-close + backdrop,
      zero library) - a small `openModal({ title, body, onClose? })` helper any current/future screen
      can reuse, not something Tuya-specific bolted onto `views/tuya/`.
- [x] **Compact card** (`views/tuya/view.js`'s `renderDevice()` rewritten): name, category, status
      dot/freshness text, the **primary control only** (Phase 10's `switch`/`switch_1`/`switch_led`
      heuristic) shown inline as a toggle right on the card - so the single most common action (flip
      the main switch) never needs a click-through. A "Details" button (or clicking the card itself)
      opens the modal for everything else. Rename/hide/unregister move into the modal too (or a small
      overflow menu on the card - decide the exact placement once this is actually being built, not
      load-bearing for the plan).
- [x] **Modal contents**, replacing what's currently dumped flat onto the card:
  - **Controls** section: the primary control again (for consistency) plus every other `functions`
    entry, still schema-driven exactly as today - just relocated, not redesigned in kind.
  - **Advanced** (collapsed by default, per Phase 10's secondary/primary split): `countdown_*`,
    `relay_status`, `switch_type`, `switch_inching`, `light_mode`, and anything else not judged primary.
  - **Readings** section: same read-only chips as today, with Phase 10's length-filter + `VALUE_LABELS`
    translation + CSS truncation already applied.
  - A manual **refresh** button (Phase 12) local to the modal, so checking one device's latest state
    doesn't require waiting for the next poll tick.
- [x] Category grouping on the main screen stays (it's not what was flagged as bad usability) - only the
      per-device density changes.

## Phase 12 - Per-device manual refresh

- [x] `POST /api/tuya/devices/:id/refresh` - forces one immediate `getBulkStatus`/local `probe()` for
      *just* that device (not the whole account), updates the shared poller cache
      (`poller.getCachedDps`/`store.updateDeviceRuntime`) the exact same way a normal tick would, and
      returns the fresh device. Reuses `local.js`/`cloud.js` as they exist today - no new fetching logic,
      just an on-demand single-device version of what the poller already does on a timer.
- [x] Frontend: refresh button in the device modal (Phase 11) and optionally directly on the compact
      card too (a small icon button) - decide placement when building it, not load-bearing here.
- [x] Rate-limit this lightly server-side (e.g. reject a second manual refresh for the same device inside
      a few seconds) so a user mashing the button can't spam Tuya's API - mirrors how `/system/internet/
      speedtest` already coalesces concurrent requests into the one already in flight rather than
      queuing duplicates.

## Phase 13 - Camera snapshots ⚠️ code written, NOT live-verified (see the constraint note below)

- [ ] **Verify against the real account before trusting this code** - attempted, but couldn't be
      completed safely (see "Important constraint" below): Tuya's camera snapshot flow is two-step and
      **async** - `POST /v1.0/end-user/ipc/{device_id}/capture/allocate` (kicks off a capture; body
      includes a capture type, e.g. a still picture) returns a job id, then `POST
      /v1.0/end-user/ipc/{device_id}/capture/resolve` is polled (Tuya's own docs suggest ~2s intervals)
      until it returns `READY` with a `decrypt_image_url` (or `NOT_READY` - keep polling, with a sane
      overall timeout, e.g. 15-20s). A first live attempt against a real camera got `token invalid (code
      1010)` - **not** a real rejection of this endpoint, a symptom of the token-contention issue caused
      by testing with the same credentials the live container was also using at that moment (see below).
      **Still an open question**: whether this lives under a distinct "Camera Service"/IPC subscription
      separate from IoT Core - unconfirmed either way now, same risk this plan already flagged before
      writing the code (echoing the IoT Core "data center suspended" red herring from Phase 0).
- [x] `cloud.js`: `requestCameraSnapshot(config, deviceId)` - written to match Tuya's documented
      allocate+poll shape; **not live-verified** (see above).
- [x] Route: `POST /api/tuya/devices/:id/snapshot` (only meaningful for `category === 'sp'` devices) -
      wiring itself confirmed structurally (404 on unknown device, 400 on a not-yet-configured account,
      via a throwaway Docker container with no real Tuya credentials involved - safe, no contention
      risk). Whether `decrypt_image_url` is directly browser-fetchable as-is, or the API needs to
      proxy/re-host the bytes itself, is genuinely unknown until tested against a real camera.
- [x] Frontend: on-demand only (a "View snapshot" button, no auto-refreshing thumbnail) - built and
      wired into the device modal; the actual round trip (loading state → real image) is exactly the
      part Phase 13's other items above couldn't verify.
- [ ] **Real verification still needed** - the user trying "View snapshot" on a real camera from the
      deployed `#tuya` screen is the safe way to actually confirm this phase works, now that it's live
      (single token source, no contention risk at that point).

## Phase 14 - Automations / routines

The largest, most novel piece of this v2 round - nothing in the existing codebase is quite this shape
(event-driven, user-defined rules), the closest relative is the Tasks scheduler (cron-based, not
event-based) and `features/system/health-watch.js` (fires on a state *transition*, which this reuses the
idea of, but health-watch's triggers/actions are both hardcoded, not user-defined).

- [x] **Data model** - new `features/automations/store.js` (own tables, `db.exec` at import time like
      every other feature):
  - `automation_rules`: `id`, `name`, `enabled`, `trigger_device_id`, `trigger_code` (the DPS code to
    watch, e.g. `doorcontact_state`), `trigger_value` (fires when the DPS *becomes* this value - v1 of
    this feature is deliberately just "became equal to X", not a general expression language), `actions`
    (JSON array - see below), `created_at`/`updated_at`.
  - `automation_runs`: `id`, `rule_id` (FK, `ON DELETE CASCADE`), `ran_at`, `ok`, `detail` - same
    run-history shape as `job_runs`/`uptime_checks`, so the eventual UI can reuse the same "view history"
    pattern already established elsewhere instead of inventing a new one.
- [x] **Action shape** (stored as JSON in `actions`, an array so one rule can do more than one thing):
  - `{ type: 'tuya_command', deviceId, code, value }` - calls `cloud.sendCommand` exactly like a manual
    control does (Phase 4's existing function, no new Tuya-calling code needed).
  - `{ type: 'telegram', chatId, message }` - calls `notifications/telegram.js`'s existing
    `sendTelegramMessage(token, chatId, message)` directly, `token` from `getDecryptedBotToken()`
    (`notifications/store.js`) - **deliberately not** wired through the existing 5 fixed
    `notification_routes` event types (`job_failure`/`container_down`/etc.): those model fixed *system*
    events with one route each, whereas an automation's message/target chat is user-defined per rule.
    Reusing the Telegram-sending primitive is right; reusing the fixed-event-type routing table isn't.
    Fails the same way manual "Testar" already does if the bot isn't configured yet (`err.botNotConfigured`).
- [x] **Trigger evaluation** - built differently than this plan originally sketched, and better for it:
      instead of hooking a diff step directly into `features/tuya/poller.js`'s cloud tick (which would
      make the `tuya` feature responsible for knowing automations exist - backwards dependency), it's
      its **own independent poller** (`features/automations/engine.js`, `startAutomationsEngine()`,
      default every 15s), the same shape `features/system/health-watch.js` already uses: it reads
      `tuya/poller.js`'s already-exported `getCachedDps()` from the outside, keeps its own
      `deviceId:code → last value` map (only for pairs at least one rule watches), and only evaluates
      rules on an actual change from that remembered value. Same debounce discipline as `health-watch.js`
      either way: fire only on the transition, never again while the value stays the same, and never on
      the very first read for a given pair (that one only seeds the baseline).
  - Record every fire (success or failure of each individual action) into `automation_runs`, same shape
    as `job_runs`. **Live-tested** via `POST /api/automations/rules/:id/run` (bypasses the trigger,
    fires actions directly) against fake device/chat ids with neither Tuya nor Telegram configured -
    both actions failed as expected, with a real per-action error message (`"telegram failed: Telegram
    bot not configured; tuya_command failed: Tuya not configured"`) correctly recorded and surfaced via
    `lastRun`/`GET .../runs`. **Not live-tested**: the actual background tick's diff/transition logic
    itself (`tick()` in `engine.js`) - doing so needs real DPS values flowing through `tuya/poller.js`'s
    cache, which needs a configured Tuya account, which this session avoided touching further after the
    token-contention incident below. Verified by careful re-reading instead of a real run; worth the
    user watching the API logs (`docker logs pi-dashboard-api -f`) after creating a real rule and
    triggering its condition for a real end-to-end confirmation.
- [x] **Routes** (`features/automations/` + `routes/automations.routes.js`, same `requireAuth`+
      `asyncHandler` shape as every other route group): `GET`/`POST /api/automations/rules`, `PUT`/
      `DELETE /api/automations/rules/:id`, `POST /api/automations/rules/:id/run` (test-fire it manually,
      same "Run now" idea Tasks jobs already have), `GET /api/automations/rules/:id/runs` (history).
- [x] **UI** - a new "Automações"/Automations panel on the `#tuya` screen (below the device list, not a
      new top-level sidebar screen - v1 of this feature is Tuya-trigger-only, so it belongs where its
      only trigger source lives; revisit promoting it to its own screen if/when it ever grows a
      non-Tuya trigger type). Rule form: pick a device (dropdown from `GET /api/tuya/devices`) → pick
      one of *that device's* schema codes (populated dynamically from its `status`/`functions`, not a
      free-text field) → value it should become (a `<select>` if the code is `Boolean`/`Enum`, matching
      Phase 7's existing per-type control logic, so this isn't a second implementation of the same
      schema-driven-input idea) → one or more actions (device+code+value picker for `tuya_command`,
      reusing the same device/code/value UI as the trigger side; chat id + message text for `telegram`).
      Each existing rule shown as a row/card with enabled toggle, "Run now", "View history", delete -
      same visual language as a Tasks job or an Uptime target, not a new pattern.
- [x] **Genericity note for this phase specifically**: the trigger/action shapes above (`{ type: ...,
      ...params }`) are deliberately a tagged union that's easy to add a third `type` to later (e.g. a
      non-Tuya trigger source, or a "run a scheduler action" action) without a schema migration - matches
      how `jobs.action` already stores its own tagged-union JSON (`{ type: 'compose-update', project }`
      etc. - see the Tasks section of `docs/ARCHITECTURE.md`).

## Phase 15 - Camera snapshots, reworked to use the Message Service (2026-09-14)

The original `/v1.0/end-user/ipc/.../capture/allocate+resolve` flow (Phase 13) was deployed and failed
for real, consistently, with `token invalid (code 1010)` - not a testing artifact (the token-race fix
above didn't change it). Root cause, confirmed by reading Tuya's actual docs for that endpoint family:
it's scoped to an **end-user OAuth token** (a real Tuya app user's login session), not the Client
ID/Secret this dashboard authenticates with everywhere else - a hard auth-model mismatch, not something
fixable by retrying or fixing a race.

Asked the user how to proceed (three options: drop snapshots, link out to the Tuya app instead, or
build the real Message Service integration) - **chose to build it properly**.

- [x] **Found and downloaded Tuya's actual official Node.js SDK** (linked from developer.tuya.com's own
      docs, not guessed) - it's distributed only as a ZIP on the docs page (not published to npm or a
      maintained public repo), so it was downloaded and its source read directly rather than trusting a
      search-engine summary of it (same discipline as every other Tuya integration decision this
      session). Confirmed it's genuinely lightweight - plain WebSocket (`ws`) + AES decryption via
      Node's built-in `crypto`, **not** the heavy native Apache Pulsar C++ client the "Pulsar" name
      suggested it might need (which would likely have been a real problem on this Alpine/ARM64 image).
- [x] `features/tuya/messaging.js` - self-implemented against that real source (not adopted as a
      dependency, since it isn't a published/maintained package): connects to
      `wss://mqe.tuya{region}.com:8285/ws/v2/consumer/persistent/{clientId}/out/event/{clientId}-sub`,
      authenticates via `username`/`password` WebSocket headers (password derived from the Client
      Secret via the exact MD5 scheme the real SDK uses), decrypts each incoming message (AES-128-ECB
      or AES-128-GCM depending on the message's own `em` property), acks by `messageId`. **On-demand
      only** - opens a connection right before triggering a capture, closes it once the matching
      message arrives or a 20s timeout passes - no persistent always-on connection to manage.
- [x] `cloud.js`'s `requestCameraSnapshot` reworked: triggers `POST /v1.0/cameras/{id}/actions/capture`
      (the same Client ID/Secret token as everything else - confirmed accepted, unlike the end-user
      endpoint) and awaits `messaging.waitForCaptureResult()` for the async image URL.
  - **Real gap, disclosed rather than guessed past**: the exact JSON shape of a capture-completed push
    message isn't documented in Tuya's public message-type reference (checked - it lists property/
    status/action-result message *categories*, not this specific one by field name). `extractImageUrl()`
    checks several plausible field names defensively and **logs the full raw decrypted message either
    way**, so the first real capture attempt against this code doubles as the final confirmation of the
    real shape - either it already matches one of the guesses, or the log gives the exact field to add.
- [x] `ws` added to `api/package.json` (`^8.x`) - confirmed pure JS, no native/compiled dependency,
      builds and boots cleanly on the real `node:20-alpine` image.
- [ ] **Real end-to-end confirmation still pending.** First real attempt hit a *different* error than
      the auth one this phase fixed: `No permissions. This API is not subscribed. (code 28841101)` -
      same shape as Phase 0's IoT Core gap, just for the camera capture call specifically. The user
      subscribed a service called **"Camera Service"** in the console for it. Not yet re-tested since -
      ask the user to try "View snapshot" again; if it still fails, read `docker logs pi-dashboard-api`
      for the raw message log line (once the capture call itself succeeds) to fix `extractImageUrl()`
      with real data instead of another guess.

## Phase 15 status: paused (2026-09-14)

After enabling Message Service (previous section) and waiting, the next real attempt got further but
hit a *fourth* distinct permission layer: `permission deny (code 1106)` on the capture-trigger call
itself (`POST /v1.0/cameras/{id}/actions/capture`). Researched properly rather than guessing again -
found no official documentation of this exact code for this endpoint, but multiple independent sources
associate "capture"/camera-action permission errors with Tuya's **Cloud Storage** service - which,
unlike IoT Core/Camera Service/Message Service (all free console toggles), is typically a **paid,
per-camera subscription**. That's a real cost decision, not another free checkbox, and by this point
four separate permission layers deep for one secondary feature.

**Decided with the user: pause here.** Not reverted - `requestCameraSnapshot`/`messaging.js`/the
"View snapshot" button all stay in place and will work as-is the moment (if ever) a camera has whatever
Tuya actually requires active. Not pursuing further verification/asking for more console changes unless
the user picks this back up - e.g. after checking whether any camera already has a Cloud Storage plan
(some ship with a free trial from the manufacturer).

## Phase 15 follow-up - real crash bug found (2026-09-14)

The user's next snapshot attempt came back as a bare `HTTP 502` (not a translated error message) - a
sign something below the app's own error handling broke. `docker logs pi-dashboard-api` confirmed it:
**every failed snapshot attempt was crashing and restarting the whole container**, not just failing the
one request (visible as repeated fresh boot sequences right after an uncaught exception, stack rooted in
`messaging.js`'s `socket.on('error', ...)` handler). Root cause: `cloud.js`'s `requestCameraSnapshot`
calls `messaging.waitForCaptureResult(...)` and holds onto the returned promise *without awaiting it
yet* while the capture-trigger HTTP call is still in flight (`await call(...)`) - if the WebSocket
handshake fails fast during that window, the promise rejects before anything has attached a `.catch` to
it, which Node.js treats as fatal (crashes the process) by default. Two-layer fix, since this exact
mistake is easy to make again in different code someday:
- [x] The immediate bug: `resultPromise.catch(() => {})` right after creating it, so it's marked
      "handled" from Node's perspective immediately, while the real `await`/`return` further down still
      sees and propagates the actual rejection normally to the route's error handling.
- [x] A systemic safety net in `server.js`: `process.on('unhandledRejection', ...)` now logs loudly
      instead of letting Node crash the whole dashboard over a bug in any one feature - explicitly not a
      substitute for fixing bugs (that's still item one), just insurance against the next one taking
      every screen offline for every user over one broken code path.
- [x] Deployed and confirmed healthy.

**Also found while investigating**: the `401` the crash was hiding turned out to have a real,
documented cause once looked up properly - subscribing "Camera Service" (Service API tab) only permits
*calling* the capture endpoint. Actually **receiving** its result needs a separate, explicit step:
**Cloud → Message Service** (a different page, not Service API) → pick the project → toggle it on →
configure. Tuya's own docs say this takes **up to ~30 minutes** to actually take effect after enabling -
worth knowing before assuming a retry failure means something's still broken. Told the user; not yet
re-confirmed.

## Phase 17 - Camera showing "offline" while genuinely on (2026-09-14)

Real bug, not a Tuya-side flakiness this time. `views/tuya/view.js`'s `statusInfo()` branched on
`device.hasLocalKey` alone to decide between "real online/offline flag" (local-capable devices) vs
"data freshness" (cloud-only devices, like the Zigbee sensors Phase 3 already fixed this exact class of
problem for). A camera **does** have a real `local_key` (Tuya's cloud hands one out for every device,
camera included) even though it's never actually locally probed (`local.js`'s own
`NO_LOCAL_PROTOCOL_CATEGORIES` already excludes category `sp`, and `poller.js`'s cloud tick already has
the matching `category !== 'sp'` check) - the frontend function's own comment already said "(and not a
camera...)" but the *code* never actually checked that, so a camera fell into the strict online/offline
branch and displayed Tuya's flaky cloud `is_online` flag as a hard fact instead of the more forgiving
freshness-based reading every other cloud-only device already gets. Fixed: added the same
`category !== 'sp'` exclusion to `statusInfo()` that `local.js`/`poller.js` already had on the backend
(`CLOUD_ONLY_CATEGORIES` in `view.js`) - a camera now shows "data updated {when}" like a Zigbee sensor
does, not a binary online/offline read of a flag that was never reliable for it. Deployed.

## Phase 19 - Two more UI reports, both fixed (2026-09-14)

- [x] The automations form's trigger-value picker (`renderValueField()`) showed generic "on"/"off" for
      `doorcontact_state` the same way the device readings did before Phase 16 - Phase 16 only fixed
      `formatDpsValue()` (the readings display), not this second, separate renderer. Now both read from
      the same `BOOLEAN_VALUE_LABELS` override.
  - **Reminder for next time**: a fix like Phase 16's needs to be grepped for other call sites, not
    assumed to be the only one - this exact class of miss (one of two renderers fixed, the other
    forgotten) is easy to repeat.
- [x] "Dispositivo aparecendo offline" (the door sensor) turned out not to be the same bug as the camera
      one (Phase 17) - `STALE_AFTER_MS` (5min) was just too tight for a sensor that, as Phase 18 above
      confirms, only ever reports on a real state change, not periodically. Five quiet minutes is normal
      for a door that hasn't moved, not a sign of anything wrong. Bumped to 24h - the freshness read is
      meant to catch a genuinely dead sensor, not second-guess a value that had no reason to change.

## Phase 18 - Local, internet-independent automation triggers (2026-09-14)

User request: the door→switch automation example wasn't reacting quickly (poll-tick + cloud-tick
latency stack up to ~45s worst case), and explicitly wanted local validation that keeps working without
internet - not just "faster polling". Investigated and built for real, not just planned:

- [x] **Confirmed live that on-demand local querying of a Zigbee sub-device doesn't work** - `get({cid:
      ..., schema: true})` through the gateway just times out. Root cause: it's a battery end-device,
      asleep almost all the time, and doesn't answer synchronous queries - a genuine Zigbee behavior,
      not a bug. This ruled out an "active local poll" design before it was built.
- [x] **Found the real mechanism, confirmed live**: a sub-device pushes a report to its gateway
      immediately on a real state change (even while otherwise asleep) - watched the gateway's own
      local connection with a passive listener and captured a real door open→close event
      (`{"dps":{"1":false},"cid":"a4c1382faa920b7e"}` → `{"dps":{"1":true},...}`, ~4s apart, zero
      internet involved) by asking the user to physically open/close the door while listening.
- [x] **`cloud.getSubDevices()`** (`GET /v1.0/devices/{id}/sub-devices`) - the missing piece: a
      sub-device's local push payload keys it by `cid` (a Zigbee node id), which is a **different**
      string than its cloud device id - confirmed live this mapping isn't guessable, has to be fetched.
- [x] **`features/tuya/gateway.js`** (new) - a *persistent* local connection to a gateway device
      (unlike `local.js`'s one-shot reachability probe), listening for `data`/`dp-refresh` events,
      resolving `cid` → the sub-device's cloud id (via the mapping above) and its raw numeric DPS index
      → cloud `code` via `LOCAL_DPS_CODE_MAP` - a small, deliberately narrow table extended one category
      at a time, **only after confirming that category's real payload live**, same discipline as every
      other "don't guess the DPS mapping" decision this project has made (Phase 3's reason local
      *control* was never built at all). Only has `mcs` (door/window contact, dps `"1"` →
      `doorcontact_state`) so far - confirmed from the capture above, not assumed. Auto-reconnects on
      disconnect.
- [x] **`features/automations/engine.js` reworked** to accept triggers from two sources feeding the
      same debounced evaluation logic (`evaluateChange()`, extracted so both paths share one
      `previousValues` baseline map): the existing poll tick (`getCachedDps`, up to ~45s latency, works
      for any device) and the new local gateway push (seconds, zero internet, only for devices
      `gateway.isLocallyTriggerable()` covers). `updateGatewayListeners()` runs each tick and
      starts/stops gateway connections to match what's actually needed right now - **only gateways with
      at least one sub-device an *enabled* rule is watching**, per the user's explicit choice, not every
      Zigbee sensor all the time.
- [x] Deployed, boots clean, `[automations-engine] motor de automações iniciado ... mais push local pra
      sensores Zigbee elegíveis` confirmed in the boot log.
- [ ] **Not yet confirmed end-to-end against a real saved rule** - the live capture above was a raw
      protocol-level test, not through a real automation rule created via the UI. Next: the user creates
      a real rule (door sensor → some switch/notification) from the `#tuya` screen's Automations panel,
      then physically opens/closes the door while watching `docker logs pi-dashboard-api -f` to confirm
      the whole chain (gateway push → `evaluateChange` → `runRule` → action) fires for real, not just
      the raw local capture in isolation.

## Phase 16 - Door/window sensor reading looked inverted (2026-09-14)

User report: closed showed as "ligado" (on). Not actually inverted logic - confirmed against Tuya's own
Standard Status Set for the "mcs" category that `doorcontact_state: true` = open / `false` = closed is
the documented standard (not guessed from the one report). The real problem was showing generic "on"/
"off" wording for a DPS that isn't an on/off concept at all - a door has no "on" state, so either value
read as slightly wrong no matter which one showed. Fixed: `views/tuya/view.js`'s `formatDpsValue()` now
has a small `BOOLEAN_VALUE_LABELS` override map (`doorcontact_state` → "open"/"closed", both real i18n
keys - `tuya.valueOpen`/`tuya.valueClosed` in `en.json`/`pt.json`, unlike `DP_LABELS`/`VALUE_LABELS`
which stay deliberately untranslated) instead of the generic on/off pair. Deployed; if the user's
specific hardware still reads backwards after this, that'd point to a real per-device firmware quirk
(happens on cheap sensors) needing a per-device override, not a global code fix - not yet built, only
worth it if this doesn't resolve it.

## Important constraint discovered mid-Phase-13 (2026-09-14)

Testing the camera snapshot flow with a **separate throwaway script using the same real Tuya
credentials while the live `pi-dashboard-api` container was also running** visibly degraded the live
container's own token (`docker logs` showed its cached token's remaining validity drop to single-digit
seconds, `[tuya-cloud] novo access_token obtido, expira em 1 s`, mirroring the exact same symptom in the
test script) - Tuya appears to have some form of single-active-token/contention behavior per
`client_id`, not independent tokens per caller. It self-healed within ~30s once the interfering script
stopped. **Consequence for how this project gets tested going forward**: never run a second process
against the real Tuya account with the same credentials while the live container is up - either test
against a *different*/throwaway Tuya project's credentials, or accept not live-verifying a Tuya-calling
change and let the user confirm it for real through the deployed UI instead (which only ever has the one
token source - the live container's own cache). Phase 13's snapshot code below was written to match
Tuya's documented request/response shape but **could not be safely live-verified** because of this -
flagged explicitly in its own checklist item rather than marked done.

**Follow-up (2026-09-14, after real deploy): the underlying race was in this project's own code, not
just a testing artifact.** The user hit the exact same `token invalid (code 1010)` trying a real
snapshot on the deployed dashboard - no concurrent script running this time, just the live container by
itself. Checking its boot log explained why: `startTuyaPoller()` kicks off the local tick and the cloud
tick immediately and concurrently, and the cloud tick itself runs `getBulkStatus`/`getBulkOnlineStatus`
via `Promise.all` - with an empty token cache at boot, **two independent token requests** fired
milliseconds apart (`novo access_token obtido` logged twice at startup, every time). Given Tuya's
apparent single-active-token-per-`client_id` behavior (same mechanism as the contention above), whichever
of the two ended up cached could be the one Tuya had already superseded/invalidated by the other -
explaining a "token invalid" that then persists for up to ~2h (until the next natural refresh), not a
one-off. **Fixed**: `cloud.js`'s `getAccessToken()` now coalesces concurrent callers into whichever
token request is already in flight for that `client_id`, instead of letting each caller fire its own -
so a device with 16+ automations/poller/manual-refresh calls all landing close together can never
trigger this again. Verified by redeploying and confirming the boot log now shows the token fetch
**once**, not twice.

## Open questions to settle before/at Phase 14 specifically

- Should a rule's trigger support "became NOT equal to X" / "changed to anything" too, or is
  became-equal-to-X (the door-open example) enough for v1? Leaning toward shipping equal-to-X only
  first - it already covers every example given, and a second condition type is easy to add once real
  usage shows it's actually needed, same spirit as everything else in this plan that started narrow.
- Does a `tuya_command` action need its own confirmation/dry-run before saving a rule (e.g. "this would
  turn on the office light"), given a misconfigured automation could do something physically unexpected
  repeatedly and silently? Worth deciding deliberately, not defaulting to "no confirmation" by omission.
