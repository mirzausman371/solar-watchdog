# ☀️ Solar Watchdog

24/7 monitor for a Knox 6.5kW hybrid inverter + 5.12kWh Powerwall (Faisalabad, PK).
Single file, **zero npm dependencies**, Node.js ≥ 20.6.

Live: `https://solar.skillmatch.tech` · runs under pm2 on the SkillMatch VPS.

## What it does

- **Polls DessMonitor cloud** every 10 min with self-refreshing auth tokens
  (no manual token copying — logs in with your SmartESS credentials)
- **Weather-aware expectations** via Open-Meteo: knows what the array *should*
  produce each hour, so alerts are about real faults, not clouds
- **8-rule alert engine**: PV string dropout, underperformance (curtailment-aware),
  battery discharge lock, output-priority regression, deep discharge,
  silent datalogger, evening sufficiency forecast, 21:00 daily digest
- **Live dashboard** (password-protected PWA): 30s refresh, 12h chart,
  power flow, per-string health, evening plan, day/week/month reports
- **FESCO meter budgets**: 7th→7th billing cycles, 200-unit protection cliff,
  protection-streak tracking with ETA, backdated bill imports, rotation-aware
  grid attribution (auto daily consumption per meter), idle-meter guard
- **Decision support**: loadshedding log, curtailment → net-metering case,
  payback tracker, battery-health estimates from discharge segments
- **Alerts** via WhatsApp (WAHA) and/or Telegram; heartbeat dead-man switch

## Run

```bash
cp .env.example .env   # fill DESS_URL, DESS_USER/PASSWORD, DASH_PASSWORD
node --env-file=.env index.mjs
# dashboard: http://localhost:8080
```

## Deploy

```bash
./deploy.sh root@your-server   # syncs code+data, starts under pm2, opens port
```

Runtime data lives next to the script: `state.json` (today), `days.json`
(daily archive), `history.jsonl` (chart samples), `meters.json` (readings +
bill history), `batt.json`, `outages.json`. All are gitignored along with `.env`.

See `CLAUDE.md` for the full project handoff, hardware details, diagnosis
history, and session log.
