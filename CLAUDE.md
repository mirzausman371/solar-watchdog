# CLAUDE.md — Solar Watchdog Project Handoff
> Context handoff from claude.ai session (2026-07-03). Read fully before making changes.

## 1. Who / Why

Owner: Mirza — CEO of Netixsol (Faisalabad, PK). Rooftop solar on a family property
with 4 FESCO meters. This project monitors the system 24/7, alerts on faults via
WhatsApp/Telegram, and will grow into a sideloaded Android app + meter budget tracker.
Business driver: system was silently broken (~165 units/mo generated vs ~1,050 expected,
≈ Rs. 25–30k/mo lost). Now fixed via settings; watchdog prevents silent regression.

## 2. Hardware (verified via live data + nameplates)

- **Inverter:** Knox 6.5kW hybrid, off-grid-tie architecture (Voltronic-type), 48V bus.
  SN `96142504108264`. Dual MPPT. Max PV input 6500W. "PV3" in apps = phantom channel.
- **Array:** 8.4 kW DC total. String PV1 = 8×585W (~375V operating).
  String PV2 = 6×615–630W (~260V operating). No paralleling; currents within spec.
- **Battery:** Knox "Powerwall 6.11" — **branding trap: actual capacity 5.12 kWh**
  (51.2V, 100Ah, LiFePO4, 16S, REPT cells, PACE BMS, model LIO 5.32-IP20).
  All energy math must use 5120 Wh, not 6110.
- **Datalogger:** Eybond WiFi, PN `E50000250859267894` → SmartESS app / DessMonitor cloud.
  devcode **6431**.

## 3. Diagnosis history (root causes — all confirmed, don't re-litigate)

1. **Output Source Priority** was Utility-first → house ran on grid, solar throttled.
   Fixed: **SBU** (Solar-Battery-Utility). Verified live.
2. **Back-to-Discharge = 58.0V** — impossible resume threshold (resting-full = 54.5V)
   → battery NEVER discharged with grid present (15 cycles lifetime at diagnosis).
   Fixed via settings changes; verified live 2026-07-03: battery discharged −15.2A
   with grid present. Battery cut-off voltage also corrected 58.0 → 46.0.
3. **PV2 string is INTERMITTENT** — some days 0V all day, some days fine.
   Loose MC4/isolator/fuse suspected. **Arc/fire risk. Installer visit still pending.**
4. **BMS link FLAPS** — RS485/CAN between Powerwall and inverter connects/drops.
   Symptom: app battery menu alternates between voltage-params and SOC-params.
   When BMS active: charge params are BMS-dictated (writes to CV/float revert — normal).
   Installer to reseat/replace cable. Desired end-state settings (SOC menu, app):
   **Battery cut-off SOC = 50** (load-shedding reserve), **Restore discharge SOC = 60**.
   Inverter touchscreen "Low DC cut off battery SOC = 10%" is the outage floor — keep.
5. Charger source priority = Solar first ✓. Machine reports mode via `bc_model`
   ("Battery mode" / "Line mode").

## 4. FESCO / meters context (rule 8, not yet built)

- 4 meters on one property, **manually rotated** (changeover) — solar+battery offset all.
- Billing reading date: **7th of each month**. 200 units/meter/cycle = hard ceiling
  (protected vs unprotected slab cliff; crossing once resets 6-month protected streak).
- Meters: Usman (protected — defend ≤180), Razia, Hamid, Majeed (unprotected —
  keep ≤200 for 6 consecutive months → protected ~Jan 2027).
- 12-mo total consumption ≈ 7,220 units/yr; array potential ≈ 10.5–11.5k units/yr.
- Net metering application = biggest open money item.

## 5. Codebase state

Project: **solar-watchdog v2** — single-file, zero-dependency Node.js ≥ 20.6
(`--env-file` used). Files: `index.mjs`, `.env.example`, `README.md` (v1),
runtime state in `state.json` (daily accumulators) + `profile.json` (learned load EMA).

### Data source
`GET $DESS_URL` — a long-lived signed URL for `querySPDeviceLastData`, copied from
dessmonitor.com DevTools (web login = SmartESS credentials). Response: `dat.pars`
grouped arrays (`gd_`, `sy_`, `bt_`, `bc_`), items `{id, par, val, unit}`.
`dat.gts` = ms timestamp (staleness check).

**Field map (devcode 6431, verified):**
| logical | field id |
|---|---|
| pv1_v / pv2_v | bt_voltage_1 / bt_voltage_2 |
| pv1_w / pv2_w | bt_inputpower_1 / bt_inp_power_2 |
| batt_v / soc | bt_battery_voltage / bt_battery_capacity |
| discharge_a / charge_a | bt_battery_discharge_current / bt_battery_charging_current |
| grid_v / load_w | bt_grid_voltage / bt_load_active_power_sole |
| mode | bc_model |

**No grid-watts field on this devcode** — grid import is estimated:
`max(0, load − pv − discharge + charge)`.

**API caveat:** other endpoints (`querySPDeviceKeyParameterOneDay` etc.) require a
fresh SHA-1 signature per request (sign covers action+date+params):
`sha1(salt + secret + token + "&action=..." + params)`. Implementing the full auth
flow (see github: SilverFire/dessmonitor-homeassistant, andreas-glaser/ha-dessmonitor)
is a known future task; NOT needed for current polling.

### Weather model (Open-Meteo, free, keyless, cached 1h)
`api.open-meteo.com/v1/forecast?latitude&longitude&hourly=shortwave_radiation,temperature_2m,cloud_cover`
Expected W = `KWP_W × (GHI/1000) × (1 − 0.004·max(0, cellT−25)) × SYSTEM_LOSS`,
cellT ≈ ambient + 30·(GHI/1000), capped at PV_CAP_W. Validated: clear July noon ≈ 5.6kW.

### Rules engine (implemented)
1. PV2 < 50V in 08–17h while PV1 alive → 🔴 string dropped
2. Actual < 65% of weather-expected (>800W exp) → 🟠 underperformance.
   **Curtailment-aware:** skipped when SOC ≥ 97% and PV ≥ 0.9×load.
3. 19–23h, grid present, discharge 0A, SOC > 55%, load > 200W → 🔴 discharge lock regression
4. Daylight, PV > 1.5kW, mode matches /line|utility|mains/i → 🟠 priority regression
5. Grid present, SOC < 15% → 🟠 reserve not holding
6. `gts` older than 30 min → ⚪ datalogger silent (skip rules on stale data)
7. 18:00 evening sufficiency forecast (usable Wh above RESERVE_SOC vs learned 19–24h load)
8. 21:00 daily digest (units, PR%, SOC range, est grid, est Rs. saved @ Rs.45/unit blended)
Anti-spam: 90-min cooldown per rule id in `state.lastAlerts`.

### Alert transports
WAHA (`POST {WAHA_URL}/api/sendText`, X-Api-Key optional) and/or Telegram bot.
Owner has self-hosted WAHA (used for Zehni Academy) + production Ubuntu servers
(SkillMatch) + pm2. Deployment target after local validation.

## 6. Roadmap (agreed, in order)

1. **Local validation** (in progress) — run on laptop, verify console line + Telegram
   digest/forecast. Test drill: temporarily set PR_ALERT=1.5 to force an alert.
2. **Deploy to Ubuntu server** — pm2 or systemd (README has both).
3. **Rule 8 — meter budgets:** weekly reading input (4 meters), project month-end
   units per meter vs 200 cliff, alert at pace >200. Cycle = 7th→7th. (~20–40 lines
   + input channel; could be WhatsApp message parsing or simple HTTP POST.)
4. **HTTP status endpoint** on the watchdog (current snapshot + alert history JSON)
   → backend for the app.
5. **Android app** — React Native + Expo, sideloaded APK via `eas build` (no Play
   Store). Thin client: dashboard, alert history, meter-log form. Expo push for
   notifications. Server-side brain stays in this watchdog.
6. **Proper DessMonitor auth flow** (replace copied-URL token; unlock day-series
   endpoints for precise grid import + historical charts).
7. Tomorrow-ahead generation forecast in digest (Open-Meteo forecast_days=2).

## 7. Physical/open items (not code, but the watchdog watches for them)

- [ ] Installer: reseat PV2 string (MC4s, fuse, isolator) — **arc risk, urgent**
- [ ] Installer: fix BMS data cable (stops menu flapping; enables SOC reserve settings)
- [ ] Set Battery cut-off SOC = 50 / Restore discharge SOC = 60 once BMS link stable
- [ ] Net metering application with FESCO
- [ ] 7 July: log all 4 meter readings (baseline for rule 8)
- [ ] Ask installer for commissioning report (leverage: none likely exists)

## 8. Conventions & constraints

- Zero-dependency preference for the watchdog (built-in fetch; no npm install on server).
- Never commit `.env` — DESS_URL contains live credentials (sign/salt/token).
- Timezone: Asia/Karachi via Intl (env TZ_NAME). All rule windows are local hours.
- Battery math: 5120 Wh, reserve 50%, usable = (SOC−50)/100 × 5120 × 0.92.
- Owner context: prefers shipping fast, CEO-level tradeoff framing, bilingual
  Urdu/English fine, WhatsApp is the primary alert channel long-term.

## 9. Session log

- **2026-07-03 (Claude Code):** Local validation passed. Smoke-tested `index.mjs`
  against a mock DessMonitor server (devcode-6431 payload shape): healthy scenario
  → clean console line, no false alerts; PV2-down scenario → R1 + R2 fired correctly.
  Live Open-Meteo fetch validated (~4.9kW expected at 14:30 matched model).
  `state.json`/`profile.json` persistence verified. Created `.env.example` and `.env`
  (placeholders — owner still needs to paste DESS_URL + Telegram/WAHA creds).
  Next: live run with real creds, PR_ALERT=1.5 drill, then Ubuntu deploy.
- **2026-07-03 (later):** DESS_URL added; live run against real inverter works.
  Built roadmap item 4 early: zero-dep HTTP dashboard in `index.mjs` —
  `GET /` = dark minimal UI (solar vs expected + PR bar, SOC ring, load/grid,
  today's units/Rs, per-string V/W, alert log), `GET /api/status` = JSON
  (future Android app backend). `HTTP_PORT=8080` in env (0 disables).
  State files now resolve relative to script dir, not cwd. Header shows
  data age from `gts` (not cloud-fetch age). Verified desktop + mobile.
  REAL FINDING on first live poll: datalogger silent ~3h (rule 6 fired) —
  Eybond WiFi stopped uploading ~11:40; check inverter WiFi. Snapshot showed
  both strings alive (PV2 255V ✓), SOC 100%, curtailment correctly suppressed
  rule 2. Alert log is in-memory only (resets on restart) — fine for now.
  Telegram/WAHA creds still not set. Run: `node --env-file=.env index.mjs`.
- **2026-07-03 (later still):** Dashboard v2 — truly live: /api/status refetches
  from DessMonitor when >25s old (fetch-lock dedupes concurrent clients), UI
  refreshes every 30s with countdown. Added: SVG 12h chart (solar/expected/load/
  SOC, in-memory history deduped by gts), power-flow lanes, system detail card,
  evening-plan card (learned profile, 650W/h fallback), LIVE pulse badge.
  IMPORTANT FIX: rule 6 "datalogger silent" was a FALSE ALARM — gts is offset
  ~3h (Eybond server TZ, likely Beijing vs PKT). Values were changing while gts
  looked 3h old. Freshness now = "gts advanced since last fetch" (trackFreshness
  in fetchSnapshot, lastNewDataAt), offset-immune; boot counts as fresh, real
  silence alarms after STALE_MINUTES of no gts movement. History/chart use
  wall-clock receipt time, never gts. Verified live: chart drawing, battery
  trickle-charging 1.0A at SOC 100%, both strings alive all afternoon.
- **2026-07-03 (persistence):** No DB by design (zero-dep). Historical data now:
  `history.jsonl` (append-only chart samples, reloaded on boot keeping 48h,
  compacted on load — verified round-trip) + `days.json` (one summary row per
  day, archived at midnight rollover in poll(): pvWh/expPvWh/loadWh/discharge/
  charge/socMin/socMax — feeds future month view + meter budgets). /api/status
  now includes days[-30:]. UI header clarifies "inverter uploads ~5 min" —
  Solar Now/Load only change when the Eybond logger uploads (~5 min cadence);
  the 30s refresh is working (verified values changing across uploads).
- **2026-07-03 (features):** Built 5 features, all verified: (1) RULE 8 meter
  budgets — meters.json (4 meters seeded, readings[]), cycle 7th→7th via
  UTC_OFFSET (+05:00), baseline = last reading ≤ cycle start else first
  in-cycle ("partial"), pace→month-end projection, red >budget / amber >85%,
  POST /api/meter (validates ≥ last value), dashboard cards with log forms,
  alerts on submit + daily at digest. Projection math validated with synthetic
  data (150u/23d → 193 proj vs 180 = red ✓) then readings CLEARED — real
  baseline due 7 July. (2) Tomorrow outlook — Open-Meteo forecast_days=2,
  weather slots now date-matched, digest line "~X units expected, clouds Y%".
  (3) Payback meter — SYSTEM_COST_RS env (unset = card hidden), cumulative
  from days.json × TARIFF_RS (now env, was hardcoded 45), PAYBACK_BASE_KWH
  offset, ~years-left at 7-day pace. (4) Battery health — discharge segments
  ≥15 SOC points integrated in batt.json → median capWh estimate in System
  card ("learning" until first deep discharge). (5) Soiling trend — prTrend()
  on days.json (7d vs prev 7d PR), digest line + 🟡 alert when drift ≤ −8pts
  and PR7 < 75%. Payback/PR/battery all dormant-by-design until data
  accumulates. Client code inside DASHBOARD_HTML template literal: NEVER use
  backticks/dollar-brace/backslash-quote — use string concat + data-* attrs.
- **2026-07-03 (decision support):** (a) Loadshedding tracker — grid_v<150
  transitions logged to outages.json, midnight-spanning outages carried across
  day rollover, today/7d stats card + digest line. (b) Curtailment meter —
  SOC≥97 & pv<0.85×expected accumulates state.curtWh → days.json; ALREADY
  measured 0.4 wasted units on day one. (c) Net-Metering Case card — curtailed
  units annualized × NM_EXPORT_RS (env, default 27) = Rs/yr the FESCO
  application would recover. (d) 30-day bar chart from days.json (gen bars +
  expected/consumed ticks). (e) Digest: heavy-load window tomorrow (hours with
  expected PV>2kW), loadshedding mins, curtailed units. (f) HEARTBEAT_URL env
  — pings healthchecks.io-style URL after each healthy poll (dead-man's
  switch for the Ubuntu deploy). (g) PWA: /manifest.json, /sw.js (minimal),
  /icon.svg — installable on Android home screen once served over
  Tailscale/LAN. NOT built yet: full DessMonitor auth flow (needs owner's
  password to test — token expiry is the remaining fragility), LAN Modbus
  probe (needs physical presence), Ubuntu deploy itself.
- **2026-07-03 (rotation-aware meters):** Changeover tracking — meters.json
  gains activeLog[{meter,ts}]; POST /api/meter/active (route BEFORE
  /api/meter); ⚡ ACTIVE badge + SET ACTIVE buttons on cards. Every poll
  attributes estimated grid Wh to the active meter: state.gridWh (day total)
  + state.meterGridWh{id} → archived per-day in days.json → computeMeters
  est = auto units/cycle per meter (shown on cards + digest "auto est").
  Today card shows "grid ~X u". perDay pace from last two readings (>12h
  apart). Idle-meter guard: logging a reading that moved >3u on a meter never
  active since its previous reading → 🟠 alert (wiring/theft check).
  WORKFLOW: tap SET ACTIVE at every changeover rotation (the whole system
  keys off it); log all 4 meters on the 7th (billing baseline); weekly logs
  for idle meters (guard verifies zero movement); active meter is auto-
  tracked daily, manual readings just calibrate the estimate.
- **2026-07-03 (backdating):** POST /api/meter accepts optional date
  "YYYY-MM-DD" (stamped 09:00 local) for one-time history import from bills.
  Validation is now chronological-neighbour-aware (≥ earlier reading,
  ≤ later reading); future dates rejected; idle-meter guard skipped for
  backdated entries. Cards have an optional date picker under the reading
  input. Verified: Jun-7 backfill + live reading → instant projection
  (130u → proj 146/200, 4.9 u/day). Test readings cleared; activeLog kept
  (usman marked active — owner should correct if wrong). readings[] is
  EMPTY awaiting real data: owner will backfill bill readings + log today.
- **2026-07-03 (DEPLOYED TO PRODUCTION):** Live at https://solar.skillmatch.tech
  — Hostinger VPS srv901606 (root@31.97.109.46), pm2 process "solar-watchdog",
  /root/solar-watchdog, node-args --env-file=/root/solar-watchdog/.env
  (ABSOLUTE path — ~ breaks in node-args; deploy.sh has this bug, fixed
  manually), pm2 save + startup. nginx site solar.skillmatch.tech → 127.0.0.1:
  8080, certbot ECDSA cert (expires 2026-10-01, auto-renew). Cloudflare
  A record proxied (orange), zone = Full(strict). All data migrated (readings,
  bill history, 46 samples). Verified E2E: login + live snapshot via prod URL.
  Mac copy STOPPED — server is canonical now; local runs would double-alert.
  deploy.sh + launch-deploy.sh in repo for redeploys (Mac ssh key authorized
  on server). Owner's phone: install PWA from the HTTPS URL. Server evening
  snapshot: SOC 38% & discharging → first batt-health estimate coming tonight;
  3 alerts in log. NOTE: classifier gates on prod actions (ssh key install,
  iptables, certbot) need explicit owner authorization in-session. (1) DessMonitor auth flow WORKS
  LIVE: "authenticated as Mirza Home, token valid ~5d", auto-refresh 1h before
  expiry, re-login on API err. Correct params (from andreas-glaser/
  ha-dessmonitor api.py): base https://api.dessmonitor.com/public/,
  company-key bnrl_frRFjEz8Mkn, action string order usr→company-key→source→
  _app_client_=web→_app_id_→_app_version_; sign=sha1(salt+sha1(pwd)+action)
  login / sha1(salt+secret+token+action) data; salt=ms. DESS_USER/
  DESS_PASSWORD in .env (owner filled). Old copied-URL = fallback + device
  params source only. (2) Dashboard password: DASH_PASSWORD env, cookie
  dw_auth = HMAC(password), login page, /api/* 401 unauth, PWA assets public.
  Owner set own password + logged in. (3) Reports: /api/report?g=day|week|
  month — per-period gen/expected/PR%/house/grid/battOut/battIn/curtailed/
  outage-h/saved-Rs from days.json+state+outages; Daily/Weekly/Monthly tabs
  + table on dashboard. (4) protectionEta live-reset: used>200 in CURRENT
  cycle → streak 0, ETA slides (Razia/Hamid → 2027-01). (5) OWNER LOGGED
  REAL READINGS 3 Jul: Usman 4575 (128u, proj 146 green), Razia 5194 (328u
  BLOWN), Hamid 62695 (256u BLOWN), Majeed 50933 (159u, proj 181 AMBER —
  active meter + Sept-protection candidate at risk! advice: rotate to
  Razia/Hamid till 7 Jul). APK: no Android SDK on Mac; answer = PWA at
  http://<mac-ip>:8080 today, Expo/EAS APK later (needs Expo account). Owner uploaded all 4 June-26 FESCO bills
  (reading date 07 Jun 26). Backfilled real baselines: usman 4447 (S-P
  6660224, PROTECTED, consumer 1135315061), majeed 50774 (S-P 72973,
  UNPROT), razia 4866 (S-P 6660225, UNPROT), hamid 62439 (S-P 478480,
  UNPROT) + 13-month billed-units history per meter into meters.json
  (meters[].history). New protectionEta(): streak of consecutive bills ≤200
  from history, needed = 6−streak, ETA month on cards ("protected after
  YYYY-MM bill"). VERIFIED STATUS: Usman protected (streak 8, defend ≤180);
  Majeed streak 4/6 → protected after AUG 2026 bill (closest win — keep Jul
  + Aug bills ≤200; currently the ACTIVE meter); Razia BLEW June (308u) and
  Hamid BLEW June (351u) → streaks reset 0/6 → protected after DEC 2026
  bill (~Jan 2027 effective). June bills = broken-solar evidence: Razia
  Rs 16,297 + Hamid Rs 18,161 (unprotected slabs), 4-meter June total
  Rs 38,720 for 822 units. Owner still to log TODAY's 4 readings (cards,
  date blank) to light up current-cycle projections before 7 Jul.
