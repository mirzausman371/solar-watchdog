// ============================================================
//  SOLAR WATCHDOG v2 — Knox 6.5kW + Powerwall (devcode 6431)
//  v2 adds:
//   • Weather-aware expected-output model (Open-Meteo, free/no key)
//   • Curtailment-aware underperformance alerts
//   • Self-learning hourly load profile (EMA)
//   • Evening battery sufficiency forecast
//   • Performance Ratio in daily digest
//  Zero dependencies. Node.js >= 18.
// ============================================================

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";

const DIR = import.meta.dirname; // state files live next to the script, not cwd

// ---------- CONFIG ----------
const CFG = {
  DESS_URL: required("DESS_URL"),
  POLL_MINUTES: num(process.env.POLL_MINUTES, 10),
  TZ: process.env.TZ_NAME || "Asia/Karachi",

  // Site & system model
  LAT: num(process.env.LAT, 31.42),          // Faisalabad default
  LON: num(process.env.LON, 73.08),
  KWP_W: num(process.env.KWP_W, 8400),        // array DC watts
  PV_CAP_W: num(process.env.PV_CAP_W, 6500),  // inverter max PV input
  SYSTEM_LOSS: num(process.env.SYSTEM_LOSS, 0.86), // wiring+soiling+inverter
  BATT_WH: num(process.env.BATT_WH, 5120),    // Powerwall real capacity
  RESERVE_SOC: num(process.env.RESERVE_SOC, 50),

  // Alerts
  WAHA_URL: process.env.WAHA_URL || "",
  WAHA_SESSION: process.env.WAHA_SESSION || "default",
  WAHA_CHAT_ID: process.env.WAHA_CHAT_ID || "",
  WAHA_API_KEY: process.env.WAHA_API_KEY || "",
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",

  // Thresholds
  PV2_DEAD_VOLTS: num(process.env.PV2_DEAD_VOLTS, 50),
  PR_ALERT: num(process.env.PR_ALERT, 0.65),  // actual < 65% of expected → alert
  EVENING_SOC_LOCK: num(process.env.EVENING_SOC_LOCK, 55),
  DEEP_SOC: num(process.env.DEEP_SOC, 15),
  STALE_MINUTES: num(process.env.STALE_MINUTES, 30),
  ALERT_COOLDOWN_MIN: num(process.env.ALERT_COOLDOWN_MIN, 90),
  DIGEST_HOUR: num(process.env.DIGEST_HOUR, 21),
  FORECAST_HOUR: num(process.env.FORECAST_HOUR, 18), // evening sufficiency check

  STATE_FILE: process.env.STATE_FILE || join(DIR, "state.json"),
  PROFILE_FILE: process.env.PROFILE_FILE || join(DIR, "profile.json"),
  HISTORY_FILE: process.env.HISTORY_FILE || join(DIR, "history.jsonl"), // chart samples, append-only
  DAYS_FILE: process.env.DAYS_FILE || join(DIR, "days.json"),           // one summary row per day
  METERS_FILE: process.env.METERS_FILE || join(DIR, "meters.json"),     // FESCO readings + budgets
  BATT_FILE: process.env.BATT_FILE || join(DIR, "batt.json"),           // battery capacity estimates

  // Money & meters
  TARIFF_RS: num(process.env.TARIFF_RS, 45),            // blended Rs/unit for savings math
  SYSTEM_COST_RS: num(process.env.SYSTEM_COST_RS, 0),   // total install cost; 0 hides payback card
  PAYBACK_BASE_KWH: num(process.env.PAYBACK_BASE_KWH, 0), // units generated before tracking began
  UTC_OFFSET: process.env.UTC_OFFSET || "+05:00",       // Asia/Karachi is fixed UTC+5 (no DST)
  NM_EXPORT_RS: num(process.env.NM_EXPORT_RS, 27),      // net-metering export rate Rs/unit
  OUTAGES_FILE: process.env.OUTAGES_FILE || join(DIR, "outages.json"), // loadshedding log
  HEARTBEAT_URL: process.env.HEARTBEAT_URL || "",       // dead-man's switch ping (healthchecks.io)

  // DessMonitor login (streamlined auth — tokens auto-refresh forever).
  // When set, DESS_URL is only used for its device params (pn/sn/devcode/…).
  DESS_USER: process.env.DESS_USER || "",
  DESS_PASSWORD: process.env.DESS_PASSWORD || "",

  // Dashboard password (empty = open; REQUIRED before any public deploy)
  DASH_PASSWORD: process.env.DASH_PASSWORD || "",

  // Tuya Cloud — TOMZN whole-house energy breaker (real grid measurement)
  TUYA_ID: process.env.TUYA_ACCESS_ID || "",
  TUYA_SECRET: process.env.TUYA_ACCESS_SECRET || "",
  TUYA_DEVICE: process.env.TUYA_DEVICE_ID || "",
  TUYA_REGION: process.env.TUYA_REGION || "eu",   // us | eu | cn | in (your Smart Life account's data center)
  TUYA_ROLE: process.env.TUYA_ROLE || "grid",     // grid = breaker measures WAPDA import; house = total consumption
  TUYA_KWH_SCALE: num(process.env.TUYA_KWH_SCALE, 100),   // raw→kWh divisor (TOMZN usually 100); calibrate on first read
  TUYA_KWH_FILE: process.env.TUYA_KWH_FILE || join(DIR, "tuya.json"),
  TUYA_CONTROL: process.env.TUYA_CONTROL === "1",         // enable WRITE commands to the breaker (can cut the house)

  // Grid-load alert (#1) + water-pump detection (#2 — Faisal 2.5HP, ~2kW, float-switch)
  GRID_HIGH_W: num(process.env.GRID_HIGH_W, 1800),        // alert when breaker power exceeds this
  PUMP_W: num(process.env.PUMP_W, 2000),                  // rated pump draw (2.5HP @ 220V/9A)
  PUMP_STEP_W: num(process.env.PUMP_STEP_W, 1500),        // sudden load step that flags pump on/off
  PUMP_ON_W: num(process.env.PUMP_ON_W, 1600),           // grid power that keeps the pump "running"
  PUMP_MAX_RUN_MIN: num(process.env.PUMP_MAX_RUN_MIN, 45), // over-run → stuck-float / dry-run alert
  PUMP_POLL_MIN: num(process.env.PUMP_POLL_MIN, 3),       // fast breaker poll for pump/grid detection
  PUMP_FILE: process.env.PUMP_FILE || join(DIR, "pump.json"),
  HTTP_PORT: num(process.env.HTTP_PORT, 8080), // 0 disables the dashboard
  PUBLIC_URL: (process.env.PUBLIC_URL || "https://solar.skillmatch.tech").replace(/\/+$/, ""),
};

function required(k) { const v = process.env[k]; if (!v) { console.error(`Missing env: ${k}`); process.exit(1); } return v; }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// ---------- FIELD MAP (devcode 6431, verified) ----------
const FIELDS = {
  pv1_v: "bt_voltage_1", pv2_v: "bt_voltage_2",
  pv1_w: "bt_inputpower_1", pv2_w: "bt_inp_power_2",
  batt_v: "bt_battery_voltage", soc: "bt_battery_capacity",
  discharge_a: "bt_battery_discharge_current", charge_a: "bt_battery_charging_current",
  grid_v: "bt_grid_voltage", load_w: "bt_load_active_power_sole",
};
const MODE_FIELD = "bc_model";

// ---------- PERSISTENCE ----------
function loadJson(f, fallback) { if (existsSync(f)) { try { return JSON.parse(readFileSync(f, "utf8")); } catch {} } return fallback; }
function saveJson(f, o) { writeFileSync(f, JSON.stringify(o, null, 2)); }
function freshDay(date) {
  return { date, pvWh: 0, expPvWh: 0, loadWh: 0, dischargeWh: 0, chargeWh: 0, curtWh: 0,
           gridWh: 0, meterGridWh: {}, gridMeasWh: 0, meterMeasWh: {}, gridDirectWh: 0,
           socMin: 100, socMax: 0, gridOutStart: null,
           lastAlerts: {}, digestSent: false, forecastSent: false };
}
function freshProfile() { return { hourlyLoadW: Array(24).fill(0), seen: Array(24).fill(0) }; }

// ---------- TIME ----------
function nowParts() {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: CFG.TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// ---------- WEATHER (Open-Meteo, cached 1h) ----------
let weatherCache = { ts: 0, hours: null };
async function getWeather() {
  if (Date.now() - weatherCache.ts < 55 * 60_000 && weatherCache.hours) return weatherCache.hours;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${CFG.LAT}&longitude=${CFG.LON}` +
    `&hourly=shortwave_radiation,temperature_2m,cloud_cover&forecast_days=2&timezone=${encodeURIComponent(CFG.TZ)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
  const j = await res.json();
  const hours = j.hourly.time.map((t, i) => ({
    date: t.slice(0, 10),
    hour: Number(t.slice(11, 13)),
    ghi: j.hourly.shortwave_radiation[i],   // W/m²
    temp: j.hourly.temperature_2m[i],       // °C
    cloud: j.hourly.cloud_cover[i],         // %
  }));
  weatherCache = { ts: Date.now(), hours };
  return hours;
}

// Expected PV watts for a given hour's weather
function expectedPvW(ghi, ambientC) {
  if (!ghi || ghi <= 0) return 0;
  const cellT = ambientC + 30 * (ghi / 1000);          // NOCT approximation
  const tempDerate = 1 - 0.004 * Math.max(0, cellT - 25); // LiFePO4-era mono coefficient
  const w = CFG.KWP_W * (ghi / 1000) * tempDerate * CFG.SYSTEM_LOSS;
  return Math.min(w, CFG.PV_CAP_W);
}

// Tomorrow's expected generation (kWh) + midday cloud cover, for the digest
function tomorrowOutlook(wx, todayDate) {
  const tom = wx.filter(x => x.date > todayDate);
  if (!tom.length) return null;
  const kwh = tom.reduce((sum, x) => sum + expectedPvW(x.ghi, x.temp), 0) / 1000;
  const midday = tom.filter(x => x.hour >= 10 && x.hour <= 15);
  const cloud = midday.length ? Math.round(midday.reduce((s, x) => s + x.cloud, 0) / midday.length) : 0;
  return { kwh, cloud };
}

// ---------- DESSMONITOR AUTH (self-refreshing tokens) ----------
// Sign scheme (per the public dessmonitor integrations):
//   login: sha1(salt + sha1(password) + "&action=authSource&usr=…&source=1&company-key=…")
//   data:  sha1(salt + secret + token + "&action=…&params")
const DESS_BASE = "https://api.dessmonitor.com/public/";
const DESS_COMPANY_KEY = "bnrl_frRFjEz8Mkn";
const DESS_APP = "&_app_client_=web&_app_id_=solar-watchdog&_app_version_=2.0.0";
const sha1 = (s) => createHash("sha1").update(s).digest("hex");

// Device identity (pn/sn/devcode/devaddr/i18n/source) comes from the copied URL
function deviceParams() {
  const u = new URL(CFG.DESS_URL);
  const keep = ["i18n", "lang", "source", "devcode", "pn", "devaddr", "sn"];
  const out = [];
  for (const [k, v] of u.searchParams) if (keep.includes(k)) out.push(`${k}=${encodeURIComponent(v)}`);
  return out.join("&");
}

let dessAuth = { token: null, secret: null, expireAt: 0 };

async function dessLogin() {
  const salt = Date.now().toString();
  const action = `&action=authSource&usr=${encodeURIComponent(CFG.DESS_USER)}&company-key=${DESS_COMPANY_KEY}&source=1${DESS_APP}`;
  const sign = sha1(salt + sha1(CFG.DESS_PASSWORD) + action);
  const res = await fetch(`${DESS_BASE}?sign=${sign}&salt=${salt}${action}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`login HTTP ${res.status}`);
  const j = await res.json();
  if (j.err !== 0) throw new Error(`DessMonitor login failed (err ${j.err}: ${j.desc})`);
  // refresh 1h before the server-declared expiry (typically ~7 days)
  dessAuth = {
    token: j.dat.token, secret: j.dat.secret,
    expireAt: Date.now() + (Number(j.dat.expire) || 7 * 86400) * 1000 - 3600_000,
  };
  console.log(`DessMonitor: authenticated as ${CFG.DESS_USER}, token valid ~${Math.max(1, Math.round((dessAuth.expireAt - Date.now()) / 86400e3))}d`);
}

async function dessDataUrl() {
  if (!CFG.DESS_USER || !CFG.DESS_PASSWORD) return CFG.DESS_URL; // fallback: static copied URL
  if (!dessAuth.token || Date.now() > dessAuth.expireAt) await dessLogin();
  const salt = Date.now().toString();
  const action = `&action=querySPDeviceLastData&${deviceParams()}${DESS_APP}`;
  const sign = sha1(salt + dessAuth.secret + dessAuth.token + action);
  return `${DESS_BASE}?sign=${sign}&salt=${salt}&token=${dessAuth.token}${action}`;
}

// ---------- TUYA CLOUD (TOMZN energy breaker) ----------
// OpenAPI HMAC-SHA256 scheme: token sign = id+t+stringToSign;
// business sign = id+access_token+t+stringToSign.
const TUYA_HOSTS = { us: "https://openapi.tuyaus.com", eu: "https://openapi.tuyaeu.com",
  cn: "https://openapi.tuyacn.com", in: "https://openapi.tuyain.com" };
const TUYA_EMPTY_SHA = createHash("sha256").update("").digest("hex");
const tuyaHost = () => TUYA_HOSTS[CFG.TUYA_REGION] || TUYA_HOSTS.eu;
const tuyaSign = (str) => createHmac("sha256", CFG.TUYA_SECRET).update(str).digest("hex").toUpperCase();
let tuyaAuth = { token: null, expireAt: 0 };
let tuyaRawLogged = false;

async function tuyaToken() {
  const t = Date.now().toString();
  const path = "/v1.0/token?grant_type=1";
  const strToSign = `GET\n${TUYA_EMPTY_SHA}\n\n${path}`;
  const sign = tuyaSign(CFG.TUYA_ID + t + strToSign);
  const res = await fetch(tuyaHost() + path, {
    headers: { client_id: CFG.TUYA_ID, sign, t, sign_method: "HMAC-SHA256" },
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  if (!j.success) throw new Error(`Tuya token err ${j.code}: ${j.msg}`);
  tuyaAuth = { token: j.result.access_token, expireAt: Date.now() + (j.result.expire_time - 60) * 1000 };
  console.log(`Tuya: authenticated (${CFG.TUYA_REGION}), token valid ${Math.round(j.result.expire_time / 60)}m`);
}

async function tuyaStatus() {
  if (!CFG.TUYA_ID || !CFG.TUYA_DEVICE) return null;
  if (!tuyaAuth.token || Date.now() > tuyaAuth.expireAt) await tuyaToken();
  const t = Date.now().toString();
  const path = `/v1.0/devices/${CFG.TUYA_DEVICE}/status`;
  const strToSign = `GET\n${TUYA_EMPTY_SHA}\n\n${path}`;
  const sign = tuyaSign(CFG.TUYA_ID + tuyaAuth.token + t + strToSign);
  const res = await fetch(tuyaHost() + path, {
    headers: { client_id: CFG.TUYA_ID, access_token: tuyaAuth.token, sign, t, sign_method: "HMAC-SHA256" },
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  if (!j.success) { tuyaAuth.token = null; throw new Error(`Tuya status err ${j.code}: ${j.msg}`); }
  return j.result; // [{code, value}, ...]
}

// Write commands to the breaker (POST is signed over the body hash too)
async function tuyaCommand(commands) {
  if (!CFG.TUYA_ID || !CFG.TUYA_DEVICE) throw new Error("Tuya not configured");
  if (!tuyaAuth.token || Date.now() > tuyaAuth.expireAt) await tuyaToken();
  const t = Date.now().toString();
  const path = `/v1.0/devices/${CFG.TUYA_DEVICE}/commands`;
  const body = JSON.stringify({ commands });
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const strToSign = `POST\n${bodyHash}\n\n${path}`;
  const sign = tuyaSign(CFG.TUYA_ID + tuyaAuth.token + t + strToSign);
  const res = await fetch(tuyaHost() + path, {
    method: "POST",
    headers: { client_id: CFG.TUYA_ID, access_token: tuyaAuth.token, sign, t,
      sign_method: "HMAC-SHA256", "Content-Type": "application/json" },
    body, signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  if (!j.success) throw new Error(`Tuya cmd err ${j.code}: ${j.msg}`);
  return j.result;
}

// This TOMZN model packs live V/I/P into an 8-byte base64 blob (phase_a):
// [voltage ÷10 V][current ÷1000 A, 3B][power W, 3B]. Verified against the device.
function decodePhase(b64) {
  try {
    const b = Buffer.from(b64, "base64");
    if (b.length < 8) return null;
    return {
      voltage: ((b[0] << 8) | b[1]) / 10,
      current: ((b[2] << 16) | (b[3] << 8) | b[4]) / 1000,
      power: (b[5] << 16) | (b[6] << 8) | b[7],
    };
  } catch { return null; }
}

// Decode the alarm_set_1/2 raw blobs → protection thresholds. Each 4-byte group
// is [type, enable, value_hi, value_lo]; type IDs vary by firmware so we label by
// value range (matches TOMPD defaults: leakage 30mA, OC ~50A, UV 170V, OV 250V).
function decodeAlarms(...b64s) {
  const out = [];
  for (const b64 of b64s) {
    if (typeof b64 !== "string" || !b64) continue;
    let buf; try { buf = Buffer.from(b64, "base64"); } catch { continue; }
    for (let i = 0; i + 4 <= buf.length; i += 4) {
      const type = buf[i], on = !!buf[i + 1], val = (buf[i + 2] << 8) | buf[i + 3];
      let label = "Protection " + type, unit = "";
      if (val <= 35) { label = "Leakage trip"; unit = "mA"; }
      else if (val <= 120) { label = "Over-current"; unit = "A"; }
      else if (val <= 215) { label = "Under-voltage"; unit = "V"; }
      else { label = "Over-voltage"; unit = "V"; }
      out.push({ type, on, value: val, label, unit });
    }
  }
  return out;
}

// Normalize the TOMZN status array. Prefers the packed phase blob; falls back
// to flat DPs (cur_power/…) on models that expose them.
function tuyaParse(status) {
  const m = {};
  for (const it of status) m[it.code] = it.value;
  if (!tuyaRawLogged) { console.log("Tuya raw codes:", JSON.stringify(m)); tuyaRawLogged = true; }
  const pick = (keys) => { for (const k of keys) if (m[k] !== undefined && m[k] !== null) return Number(m[k]); return null; };
  const ph = typeof m.phase_a === "string" && m.phase_a ? decodePhase(m.phase_a) : null;
  let v = ph ? ph.voltage : pick(["cur_voltage", "voltage"]);
  let a = ph ? ph.current : pick(["cur_current", "current"]);
  let w = ph ? ph.power : pick(["cur_power", "power", "active_power"]);
  if (!ph) { // scale flat DPs when the blob isn't present
    if (v !== null && v > 1000) v /= 10;
    if (a !== null && a > 100) a /= 1000;
    if (w !== null && w > 20000) w /= 10;
  }
  const e = pick(["total_forward_energy", "add_ele", "forward_energy_total", "total_energy", "energy_forward"]);
  return {
    raw: m, voltage: v, current: a, power: w,
    pf: v && a && w ? Math.min(1, +(w / (v * a)).toFixed(2)) : null,
    kwh: e !== null ? e / CFG.TUYA_KWH_SCALE : null,        // ÷100 → kWh (verified)
    freq: m.supply_frequency != null ? Number(m.supply_frequency) / 10 : null,
    leakage: m.leakage_current != null ? Number(m.leakage_current) : null,  // mA (LW model)
    fault: m.fault ?? 0,
    on: m.switch ?? m.switch_1 ?? null,
    prepay: m.switch_prepayment ?? null,
    balance: m.balance_energy != null ? Number(m.balance_energy) / 10 : null,  // units left before auto-cutoff
    charged: m.charge_energy != null ? Number(m.charge_energy) : null,          // last top-up (kWh)
    breakerNo: m.breaker_number ?? null,
    protections: decodeAlarms(m.alarm_set_1, m.alarm_set_2),
  };
}

// ---------- FETCH INVERTER ----------
async function fetchSnapshot() {
  const res = await fetch(await dessDataUrl(), { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.err !== 0) {
    dessAuth.token = null; // token may have been revoked — re-login on next attempt
    throw new Error(`API err ${j.err}: ${j.desc}`);
  }
  const flat = {};
  for (const g of Object.values(j.dat.pars)) for (const item of g) flat[item.id] = item.val;
  const v = (k) => Number(flat[FIELDS[k]] ?? NaN);
  const out = {
    gts: Number(j.dat.gts),
    pv1_v: v("pv1_v"), pv2_v: v("pv2_v"), pv1_w: v("pv1_w") || 0, pv2_w: v("pv2_w") || 0,
    pv_w: (v("pv1_w") || 0) + (v("pv2_w") || 0),
    batt_v: v("batt_v"), soc: v("soc"),
    discharge_a: v("discharge_a"), charge_a: v("charge_a"),
    grid_v: v("grid_v"), load_w: v("load_w"),
    mode: flat[MODE_FIELD] || "unknown",
  };
  trackFreshness(out.gts);
  return out;
}

// ---------- DATA FRESHNESS ----------
// DessMonitor's gts is offset from wall clock (Eybond servers ≠ PKT), so
// absolute age is meaningless. Fresh = gts ADVANCED since the last fetch.
let lastSeenGts = 0;
let lastNewDataAt = Date.now(); // boot counts as fresh; alarms 30 min later if gts never moves
function trackFreshness(gts) {
  if (gts !== lastSeenGts) { lastSeenGts = gts; lastNewDataAt = Date.now(); }
}

// ---------- LIVE STATUS (feeds the dashboard) ----------
const latest = { snapshot: null, expW: 0, fetchedAt: 0, error: null };
const alertLog = []; // in-memory, newest first, capped

// Rolling sample history for the live chart. Deduped by gts, so it only grows
// when the datalogger actually uploads a new reading (~5 min cadence).
const history = [];
let lastHistGts = 0;
function recordHistory(s, expW) {
  if (!s || s.gts === lastHistGts) return;
  lastHistGts = s.gts;
  const disW = s.discharge_a * s.batt_v, chgW = s.charge_a * s.batt_v;
  const gridEst = Math.max(0, s.load_w - s.pv_w - disW + chgW);
  const gm = latest.tuya && latest.tuya.power != null ? Math.round(latest.tuya.power) : null;
  const gridDirect = gm != null ? Math.max(0, gm - gridEst) : 0;   // load bypassing the inverter
  const entry = {
    // wall-clock receipt time, not gts — gts carries the server's TZ offset
    t: Date.now(), pv: Math.round(s.pv_w), load: Math.round(s.load_w), soc: s.soc,
    exp: Math.round(expW), grid: Math.round(gridEst),
    gm, total: Math.round(s.load_w + gridDirect),   // true whole-house consumption
  };
  history.push(entry);
  while (history.length > 2000) history.shift();
  try { appendFileSync(CFG.HISTORY_FILE, JSON.stringify(entry) + "\n"); }
  catch (e) { console.error("history write:", e.message); }
}

// Reload persisted samples on boot (keep 48h) and compact the file.
try {
  if (existsSync(CFG.HISTORY_FILE)) {
    const cutoff = Date.now() - 48 * 3600_000;
    for (const ln of readFileSync(CFG.HISTORY_FILE, "utf8").split("\n")) {
      if (!ln) continue;
      try { const p = JSON.parse(ln); if (p.t > cutoff) history.push(p); } catch {}
    }
    writeFileSync(CFG.HISTORY_FILE, history.map(p => JSON.stringify(p)).join("\n") + (history.length ? "\n" : ""));
    console.log(`history: ${history.length} samples loaded`);
  }
} catch (e) { console.error("history load:", e.message); }

// Live fetch for the dashboard: refetch when >25s old so a 30s-refresh client
// always sees fresh cloud data, with a lock so concurrent requests share one fetch.
let fetchLock = null;
async function liveSnapshot() {
  if (Date.now() - latest.fetchedAt < 25_000 && latest.snapshot) return;
  if (!fetchLock) fetchLock = (async () => {
    try {
      latest.snapshot = await fetchSnapshot();
      latest.fetchedAt = Date.now();
      latest.error = null;
      recordHistory(latest.snapshot, latest.expW);
    } catch (e) { latest.error = e.message; }
    finally { fetchLock = null; }
  })();
  await fetchLock;
}

// Same live-refresh for the TOMZN breaker — without this the dashboard only saw
// the 10-min poll's reading and lagged the Smart Life app by minutes.
let tuyaLiveLock = null;
async function tuyaLive() {
  if (!CFG.TUYA_ID || !CFG.TUYA_DEVICE) return;
  if (latest.tuya && Date.now() - (latest.tuya.ts || 0) < 25_000) return;
  if (!tuyaLiveLock) tuyaLiveLock = (async () => {
    try {
      const st = await tuyaStatus();
      if (st) { latest.tuya = { ...tuyaParse(st), ts: Date.now() }; latest.tuyaErr = null; }
    } catch (e) { latest.tuyaErr = e.message; }
    finally { tuyaLiveLock = null; }
  })();
  await tuyaLiveLock;
}

// ---------- ALERTS ----------
async function sendAlert(text) {
  console.log(`[ALERT] ${text.replace(/\n/g, " | ")}`);
  alertLog.unshift({ ts: Date.now(), text });
  if (alertLog.length > 100) alertLog.pop();
  if (CFG.PUBLIC_URL) text += `\n\n📊 ${CFG.PUBLIC_URL}`; // link on outbound alerts only
  const jobs = [];
  if (CFG.WAHA_URL && CFG.WAHA_CHAT_ID) {
    jobs.push(fetch(`${CFG.WAHA_URL}/api/sendText`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(CFG.WAHA_API_KEY && { "X-Api-Key": CFG.WAHA_API_KEY }) },
      body: JSON.stringify({ session: CFG.WAHA_SESSION, chatId: CFG.WAHA_CHAT_ID, text }),
    }).catch(e => console.error("WAHA:", e.message)));
  }
  if (CFG.TELEGRAM_TOKEN && CFG.TELEGRAM_CHAT_ID) {
    jobs.push(fetch(`https://api.telegram.org/bot${CFG.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CFG.TELEGRAM_CHAT_ID, text }),
    }).catch(e => console.error("Telegram:", e.message)));
  }
  await Promise.all(jobs);
}
function shouldFire(state, id) {
  const cooled = Date.now() - (state.lastAlerts[id] || 0) > CFG.ALERT_COOLDOWN_MIN * 60_000;
  if (cooled) state.lastAlerts[id] = Date.now();
  return cooled;
}
// Cooldown for the fast monitor (runs outside the daily state object)
const monitorAlerts = {};
function monitorCooldown(id, min) {
  const now = Date.now();
  if (now - (monitorAlerts[id] || 0) > min * 60_000) { monitorAlerts[id] = now; return true; }
  return false;
}

// ---------- WATER PUMP DETECTION (unmetered — inferred from breaker load) ----------
// The Faisal 2.5HP pump draws ~2kW and cycles on a float switch. We can't read it
// directly, so we detect its on/off STEP in the breaker power and track runtime.
let pumpState = null;
function loadPump() {
  if (!pumpState) pumpState = loadJson(CFG.PUMP_FILE,
    { on: false, since: 0, lastP: 0, lastT: 0, curRun: 0, runMin: 0, energyWh: 0, date: "", overAlerted: false, runs: [] });
  const today = nowParts().date;
  if (pumpState.date !== today) { pumpState.date = today; pumpState.runMin = 0; pumpState.energyWh = 0; }
  return pumpState;
}
function detectPump(P, now) {
  const p = loadPump();
  const dt = p.lastT ? (now - p.lastT) / 60_000 : 0;   // minutes since last sample
  const delta = P - (p.lastP || 0);
  if (p.on) {
    p.runMin += dt; p.energyWh += CFG.PUMP_W * (dt / 60); p.curRun += dt;
    if (p.curRun > CFG.PUMP_MAX_RUN_MIN && !p.overAlerted) {
      sendAlert(`🟠 WATER PUMP running ${Math.round(p.curRun)} min\nUnusually long — the float switch may be stuck, the tank overflowing, or the bore running dry. Check the pump.`);
      p.overAlerted = true;
    }
    if (delta <= -CFG.PUMP_STEP_W || P < CFG.PUMP_ON_W * 0.6) {   // pump stopped
      p.runs.push({ start: p.since, end: now, min: Math.round(p.curRun) });
      while (p.runs.length > 50) p.runs.shift();
      p.on = false; p.curRun = 0; p.overAlerted = false;
    }
  } else if (delta >= CFG.PUMP_STEP_W && P >= CFG.PUMP_ON_W) {    // pump started
    p.on = true; p.since = now; p.curRun = 0; p.overAlerted = false;
  }
  p.lastP = P; p.lastT = now;
  saveJson(CFG.PUMP_FILE, p);
}

// Fast breaker monitor: high-grid-load alert (#1) + pump detection (#2)
async function pumpMonitor() {
  if (!CFG.TUYA_ID || !CFG.TUYA_DEVICE) return;
  let tp;
  try { const st = await tuyaStatus(); if (!st) return; tp = tuyaParse(st); latest.tuya = { ...tp, ts: Date.now() }; latest.tuyaErr = null; }
  catch (e) { latest.tuyaErr = e.message; return; }
  const P = tp.power;
  if (P == null) return;
  if (P >= CFG.GRID_HIGH_W && monitorCooldown("grid_high", CFG.ALERT_COOLDOWN_MIN))
    await sendAlert(`🟠 HIGH GRID LOAD: ${(P / 1000).toFixed(2)} kW on the breaker (WAPDA)\n${P >= CFG.PUMP_ON_W ? "Likely the water pump or ACs on grid." : "Heavy load on utility."}`);
  detectPump(P, Date.now());
}

// ---------- METER BUDGETS (rule 8) ----------
// 4 FESCO meters, billing cycle 7th→7th, 200 units = protected/unprotected cliff.
// FESCO account identity, billed-units history, and bill-boundary readings per
// meter (from the June-26 + July-26 bills). This is the source of truth — synced
// onto meters.json each load so cards + streaks are correct on the server too.
// NOTE (Jul-26 bills): Usman LOST protected status (231u > 200). All 4 unprotected.
const METER_META = {
  usman: { ref: "05 13214 0285107 U", consumer: "1135315061", sp: "6660224", protected: false, budget: 200,
    hist: { "2025-06": 214, "2025-07": 0, "2025-08": 142, "2025-09": 345, "2025-10": 238, "2025-11": 105, "2025-12": 172, "2026-01": 6, "2026-02": 191, "2026-03": 186, "2026-04": 149, "2026-05": 77, "2026-06": 162, "2026-07": 231 },
    reads: { "2026-06-07": 4447, "2026-07-07": 4678 } },
  majeed: { ref: "05 13214 0285109 U", consumer: "1130263446", sp: "72973", protected: false, budget: 200,
    hist: { "2025-06": 220, "2025-07": 458, "2025-08": 91, "2025-09": 152, "2025-10": 206, "2025-11": 214, "2025-12": 113, "2026-01": 237, "2026-02": 231, "2026-03": 123, "2026-04": 11, "2026-05": 23, "2026-06": 1, "2026-07": 192 },
    reads: { "2026-06-07": 50774, "2026-07-07": 50966 } },
  razia: { ref: "05 13214 0310650 U", consumer: "1135315062", sp: "6660225", protected: false, budget: 200,
    hist: { "2025-06": 197, "2025-07": 43, "2025-08": 214, "2025-09": 114, "2025-10": 157, "2025-11": 111, "2025-12": 24, "2026-01": 289, "2026-02": 235, "2026-03": 33, "2026-04": 207, "2026-05": 145, "2026-06": 308, "2026-07": 261 },
    reads: { "2026-06-07": 4866, "2026-07-07": 5127 } },
  hamid: { ref: "05 13214 0310600 U", consumer: "1130358097", sp: "478480", protected: false, budget: 200,
    hist: { "2025-06": 105, "2025-07": 253, "2025-08": 156, "2025-09": 79, "2025-10": 111, "2025-11": 126, "2025-12": 96, "2026-01": 31, "2026-02": 129, "2026-03": 46, "2026-04": 80, "2026-05": 287, "2026-06": 351, "2026-07": 184 },
    reads: { "2026-06-07": 62439, "2026-07-07": 62623 } },
};
function loadMeters() {
  let db = loadJson(CFG.METERS_FILE, null);
  if (!db) {
    db = { meters: [
      { id: "usman",  name: "Usman" },
      { id: "razia",  name: "Razia" },
      { id: "hamid",  name: "Hamid" },
      { id: "majeed", name: "Majeed" },
    ], readings: [] };
  }
  if (!db.activeLog) db.activeLog = []; // changeover rotation history {meter, ts}
  db.readings = db.readings || [];
  // Sync identity / protected / budget / history / bill readings from METER_META
  let changed = false;
  for (const m of db.meters) {
    const meta = METER_META[m.id]; if (!meta) continue;
    for (const k of ["ref", "consumer", "sp", "protected", "budget"])
      if (m[k] !== meta[k]) { m[k] = meta[k]; changed = true; }
    const hist = Object.entries(meta.hist).map(([month, units]) => ({ month, units }));
    if (JSON.stringify(m.history) !== JSON.stringify(hist)) { m.history = hist; changed = true; }
    for (const [date, val] of Object.entries(meta.reads)) {
      const ts = new Date(`${date}T00:00:00${CFG.UTC_OFFSET}`).getTime();
      if (!db.readings.some(r => r.meter === m.id && Math.abs(r.ts - ts) < 43_200_000)) {
        db.readings.push({ meter: m.id, ts, value: val }); changed = true;
      }
    }
  }
  if (changed) { db.readings.sort((a, b) => a.ts - b.ts); saveJson(CFG.METERS_FILE, db); }
  return db;
}

function activeMeterId() {
  const log = loadMeters().activeLog;
  return log.length ? log[log.length - 1].meter : null;
}

function cycleWindow() {
  const [y, mo, d] = nowParts().date.split("-").map(Number);
  let sy = y, sm = mo;
  if (d < 7) { sm -= 1; if (sm === 0) { sm = 12; sy -= 1; } }
  let ey = sy, em = sm + 1;
  if (em === 13) { em = 1; ey += 1; }
  const pad = (n) => String(n).padStart(2, "0");
  const start = new Date(`${sy}-${pad(sm)}-07T00:00:00${CFG.UTC_OFFSET}`).getTime();
  const end = new Date(`${ey}-${pad(em)}-07T00:00:00${CFG.UTC_OFFSET}`).getTime();
  return { start, end, daysLeft: Math.max(0, Math.round((end - Date.now()) / 86400e3)),
           startDate: `${sy}-${pad(sm)}-07` };
}

// Protection streak from billed-units history: 6 consecutive bills ≤200
// units flips a meter to the protected tariff; one bill >200 resets the run.
function protectionEta(m) {
  if (!m.history || !m.history.length) return null;
  const h = [...m.history].sort((a, b) => (a.month < b.month ? -1 : 1));
  let streak = 0;
  for (let i = h.length - 1; i >= 0; i--) { if (h[i].units <= 200) streak++; else break; }
  const needed = Math.max(0, 6 - streak);
  const [y, mo] = h[h.length - 1].month.split("-").map(Number);
  const d = new Date(y, mo - 1 + needed, 1);
  return { streak, needed, eta: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` };
}

function computeMeters() {
  const db = loadMeters();
  const cycle = cycleWindow();
  const active = db.activeLog.length ? db.activeLog[db.activeLog.length - 1].meter : null;
  const cycleDays = loadJson(CFG.DAYS_FILE, []).filter(r => r.date >= cycle.startDate);
  const today = loadJson(CFG.STATE_FILE, null);
  // grid units attributed to this meter, this cycle — measured (TOMZN) preferred,
  // estimated (inverter-derived) as fallback
  const sumFor = (id, key) => +((cycleDays.reduce((s, r) => s + ((r[key] || {})[id] || 0), 0) +
    (((today || {})[key] || {})[id] || 0)) / 1000).toFixed(1);
  const meters = db.meters.map(m => {
    const rs = db.readings.filter(r => r.meter === m.id).sort((a, b) => a.ts - b.ts);
    const meas = sumFor(m.id, "meterMeasWh"), est = sumFor(m.id, "meterGridWh");
    const base = { id: m.id, name: m.name, protected: m.protected, budget: m.budget,
      ref: m.ref || null, consumer: m.consumer || null, sp: m.sp || null,
      active: m.id === active, est, meas, used_auto: meas > 0 ? meas : est,
      measured: meas > 0, prot: protectionEta(m) };
    if (!rs.length) return { ...base, noData: true };
    const last = rs[rs.length - 1];
    const prev = rs[rs.length - 2];
    base.perDay = prev && (last.ts - prev.ts) > 43200e3 // needs >12h between readings
      ? +(((last.value - prev.value) / ((last.ts - prev.ts) / 86400e3)).toFixed(1)) : null;
    const before = [...rs].reverse().find(r => r.ts <= cycle.start); // cycle-start baseline
    const first = rs.find(r => r.ts > cycle.start);                  // fallback: first in-cycle
    const baseVal = before ? before.value : first.value;
    const baseTs = before ? cycle.start : first.ts;
    const used = Math.max(0, last.value - baseVal);
    const elapsed = (last.ts - baseTs) / 86400e3;
    if (elapsed < 0.25) // single fresh point — can't project a pace yet
      return { ...base, used, projected: null, status: "new", lastValue: last.value, lastTs: last.ts };
    const pace = used / elapsed;
    const projected = Math.round(used + pace * Math.max(0, (cycle.end - last.ts) / 86400e3));
    const status = projected > m.budget ? "red" : projected > 0.85 * m.budget ? "amber" : "green";
    // Already >200 THIS cycle → streak resets now; ETA slides past the bill history
    if (!m.protected && base.prot && used > 200) {
      const [cy, cm] = cycle.startDate.split("-").map(Number);
      const d = new Date(cy, cm + 6, 1); // 6 clean bills after this cycle's bill
      base.prot = { streak: 0, needed: 6, eta: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, liveReset: true };
    }
    return { ...base, used, projected, status, lastValue: last.value, lastTs: last.ts, midCycleBaseline: !before };
  });
  return { cycle, active, meters };
}

// ---------- PAYBACK / PR TREND / BATTERY HEALTH ----------
function computePayback() {
  if (!(CFG.SYSTEM_COST_RS > 0)) return null;
  const days = loadJson(CFG.DAYS_FILE, []);
  const today = loadJson(CFG.STATE_FILE, null);
  const kwh = CFG.PAYBACK_BASE_KWH + days.reduce((s, d) => s + d.pvWh, 0) / 1000 + (today ? today.pvWh / 1000 : 0);
  const savedRs = Math.round(kwh * CFG.TARIFF_RS);
  const last7 = days.slice(-7);
  const paceRsDay = last7.length
    ? (last7.reduce((s, d) => s + d.pvWh, 0) / 1000) * CFG.TARIFF_RS / last7.length : 0;
  const leftRs = Math.max(0, CFG.SYSTEM_COST_RS - savedRs);
  return {
    savedRs, costRs: CFG.SYSTEM_COST_RS,
    pct: Math.min(100, +(100 * savedRs / CFG.SYSTEM_COST_RS).toFixed(1)),
    yearsLeft: paceRsDay > 1 ? +(leftRs / paceRsDay / 365).toFixed(1) : null,
  };
}

function prTrend(days) {
  const valid = days.filter(d => d.expPvWh > 500); // skip no-weather days
  if (valid.length < 3) return null;
  const pr = (a) => Math.round(100 * a.reduce((s, d) => s + d.pvWh, 0) / Math.max(1, a.reduce((s, d) => s + d.expPvWh, 0)));
  const pr7 = pr(valid.slice(-7));
  const prev = valid.slice(-14, -7);
  const prPrev7 = prev.length >= 4 ? pr(prev) : null;
  return { pr7, prPrev7, drift: prPrev7 === null ? null : pr7 - prPrev7 };
}

function computeBattHealth() {
  const bh = loadJson(CFG.BATT_FILE, { seg: null, estimates: [] });
  if (!bh.estimates.length) return { samples: 0 };
  const caps = bh.estimates.slice(-10).map(e => e.capWh).sort((a, b) => a - b);
  const median = caps[Math.floor(caps.length / 2)];
  return { samples: bh.estimates.length, capWh: median, pct: Math.round(100 * median / CFG.BATT_WH) };
}

function outageStats() {
  const outs = loadJson(CFG.OUTAGES_FILE, []);
  const state = loadJson(CFG.STATE_FILE, null);
  const now = Date.now();
  const all = [...outs];
  const ongoing = !!(state && state.gridOutStart);
  if (ongoing) all.push({ start: state.gridOutStart, end: now });
  const midnight = new Date(`${nowParts().date}T00:00:00${CFG.UTC_OFFSET}`).getTime();
  const weekAgo = now - 7 * 86400e3;
  const clip = (o, from) => Math.max(0, Math.min(o.end, now) - Math.max(o.start, from));
  return {
    todayMin: Math.round(all.reduce((s, o) => s + clip(o, midnight), 0) / 60000),
    weekHrs: +(all.reduce((s, o) => s + clip(o, weekAgo), 0) / 3600e3).toFixed(1),
    weekCount: all.filter(o => o.end > weekAgo).length,
    ongoing,
  };
}

// The measured case for the FESCO net-metering application: units the system
// was FORCED to waste (battery full, sun up), annualized at the export rate.
function netMeteringCase() {
  const rows = loadJson(CFG.DAYS_FILE, []).slice(-30);
  const today = loadJson(CFG.STATE_FILE, null);
  const curtWh = rows.reduce((s, d) => s + (d.curtWh || 0), 0) + (today ? (today.curtWh || 0) : 0);
  const nDays = rows.length + (today ? 1 : 0);
  if (!nDays) return null;
  const kwh = curtWh / 1000;
  return { curtKwh: +kwh.toFixed(1), nDays, rsYear: Math.round((kwh / nDays) * 365 * CFG.NM_EXPORT_RS) };
}

// Tomorrow's contiguous strong-sun hours — when to run heavy loads
function surplusWindow(wx, todayDate) {
  const hrs = wx.filter(x => x.date > todayDate && expectedPvW(x.ghi, x.temp) > 2000).map(x => x.hour);
  if (!hrs.length) return null;
  return { from: Math.min(...hrs), to: Math.max(...hrs) + 1 };
}

// ---------- RULES ----------
function runRules(s, state, hour, expW) {
  const alerts = [];
  const daylight = hour >= 8 && hour <= 17;
  const evening = hour >= 19 && hour <= 23;
  const gridPresent = s.grid_v > 150;

  // R1 — PV2 dropout
  if (daylight && s.pv2_v < CFG.PV2_DEAD_VOLTS && s.pv1_v > 100) {
    if (shouldFire(state, "pv2_drop"))
      alerts.push(`🔴 PV2 STRING DROPPED\nPV2: ${s.pv2_v}V (PV1: ${s.pv1_v}V)\nCheck DC isolator / MC4.`);
  }

  // R2 — Weather-aware underperformance (curtailment-aware)
  //     Only alert if the system actually WANTED power it didn't get:
  //     skip when battery is full and load is already covered (legit curtailment).
  const curtailing = s.soc >= 97 && s.pv_w >= s.load_w * 0.9;
  if (daylight && expW > 800 && !curtailing && s.pv_w < expW * CFG.PR_ALERT) {
    if (shouldFire(state, "underperf"))
      alerts.push(`🟠 UNDERPERFORMING vs WEATHER\nActual: ${Math.round(s.pv_w)}W | Expected: ~${Math.round(expW)}W (${Math.round(100 * s.pv_w / expW)}%)\nPV1 ${s.pv1_w}W / PV2 ${s.pv2_w}W. Check strings/soiling.`);
  }

  // R3 — Discharge lock regression
  if (evening && gridPresent && s.discharge_a === 0 && s.soc > CFG.EVENING_SOC_LOCK && s.load_w > 200) {
    if (shouldFire(state, "discharge_lock"))
      alerts.push(`🔴 BATTERY NOT DISCHARGING\nSOC ${s.soc}%, load ${s.load_w}W on grid.\nBack-to-Discharge setting may have regressed.`);
  }

  // R4 — Priority regression
  if (daylight && s.pv_w > 1500 && /line|utility|mains/i.test(s.mode)) {
    if (shouldFire(state, "priority_reg"))
      alerts.push(`🟠 ON GRID DESPITE ${Math.round(s.pv_w)}W SOLAR\nMode: ${s.mode}. Verify Output Source Priority = SBU.`);
  }

  // R5 — Deep discharge with grid present
  if (gridPresent && s.soc > 0 && s.soc < CFG.DEEP_SOC) {
    if (shouldFire(state, "deep_soc"))
      alerts.push(`🟠 DEEP DISCHARGE: ${s.soc}%\nGrid available — reserve floor not holding.`);
  }
  return alerts;
}

// ---------- EVENING SUFFICIENCY FORECAST ----------
function eveningForecast(s, profile) {
  const usableWh = Math.max(0, (s.soc - CFG.RESERVE_SOC) / 100) * CFG.BATT_WH * 0.92;
  let needWh = 0;
  const parts = [];
  for (let h = 19; h <= 23; h++) {
    const w = profile.seen[h] > 0 ? profile.hourlyLoadW[h] : 650; // fallback
    needWh += w;
    parts.push(`${h}:00 ~${Math.round(w)}W`);
  }
  const lastsHrs = needWh > 0 ? usableWh / (needWh / 5) : 99;
  const verdict = usableWh >= needWh
    ? `✅ Battery covers the evening (19:00–24:00) with margin.`
    : `⚠️ Battery lasts ~${lastsHrs.toFixed(1)}h — grid takes over ~${(19 + lastsHrs).toFixed(0)}:00.`;
  return `🔮 EVENING FORECAST\nSOC ${s.soc}% → ${(usableWh / 1000).toFixed(1)} kWh usable above ${CFG.RESERVE_SOC}% reserve\nExpected evening load: ${(needWh / 1000).toFixed(1)} kWh\n${verdict}`;
}

// ---------- DIGEST ----------
function digestText(state) {
  const pv = state.pvWh / 1000, exp = state.expPvWh / 1000;
  const pr = exp > 0 ? Math.round(100 * pv / exp) : null;
  const gridEst = Math.max(0, state.loadWh - state.pvWh - state.dischargeWh + state.chargeWh) / 1000;
  return [
    `📊 SOLAR DAILY DIGEST — ${state.date}`,
    `☀️ Generated: ${pv.toFixed(1)} units${pr !== null ? ` (${pr}% of weather-expected ${exp.toFixed(1)})` : ""}`,
    `🏠 Consumed: ${(state.loadWh / 1000).toFixed(1)} units`,
    `🔋 SOC ${state.socMin}%–${state.socMax}% | discharged ${(state.dischargeWh / 1000).toFixed(1)} kWh`,
    `⚡ Grid (est): ${gridEst.toFixed(1)} units`,
    `💰 Est. saved: ~Rs. ${Math.round(pv * CFG.TARIFF_RS)}`,
  ].join("\n");
}

// ---------- MAIN ----------
async function poll() {
  const { date, hour } = nowParts();
  let state = loadJson(CFG.STATE_FILE, freshDay(date));
  if (state.date !== date) {
    // day rollover: archive yesterday's totals before resetting
    if (state.pvWh > 0 || state.loadWh > 0) {
      const days = loadJson(CFG.DAYS_FILE, []);
      days.push({
        date: state.date, pvWh: Math.round(state.pvWh), expPvWh: Math.round(state.expPvWh),
        loadWh: Math.round(state.loadWh), dischargeWh: Math.round(state.dischargeWh),
        chargeWh: Math.round(state.chargeWh), curtWh: Math.round(state.curtWh || 0),
        gridWh: Math.round(state.gridWh || 0), gridMeasWh: Math.round(state.gridMeasWh || 0),
        gridDirectWh: Math.round(state.gridDirectWh || 0),
        meterGridWh: Object.fromEntries(Object.entries(state.meterGridWh || {})
          .map(([k, v]) => [k, Math.round(v)])),
        meterMeasWh: Object.fromEntries(Object.entries(state.meterMeasWh || {})
          .map(([k, v]) => [k, Math.round(v)])),
        socMin: state.socMin, socMax: state.socMax,
      });
      saveJson(CFG.DAYS_FILE, days);
    }
    const carryOutage = state.gridOutStart || null; // outage spanning midnight
    const carryTuyaKwh = state.tuyaKwhLast ?? null;  // cumulative meter reading spans days
    state = freshDay(date);
    state.gridOutStart = carryOutage;
    state.tuyaKwhLast = carryTuyaKwh;
  }
  const profile = loadJson(CFG.PROFILE_FILE, freshProfile());

  let s;
  try { s = await fetchSnapshot(); latest.snapshot = s; latest.fetchedAt = Date.now(); latest.error = null; }
  catch (e) {
    latest.error = e.message;
    console.error(`fetch failed: ${e.message}`);
    if (shouldFire(state, "fetch_fail")) await sendAlert(`⚪ MONITORING ISSUE\nDessMonitor unreachable: ${e.message}`);
    saveJson(CFG.STATE_FILE, state); return;
  }

  const ageMin = (Date.now() - lastNewDataAt) / 60_000; // min since gts last ADVANCED
  if (ageMin > CFG.STALE_MINUTES) {
    if (shouldFire(state, "stale"))
      await sendAlert(`⚪ DATALOGGER SILENT — no new reading for ${Math.round(ageMin)} min. Check inverter WiFi.`);
    saveJson(CFG.STATE_FILE, state); return;
  }

  // Weather-expected output for this hour (fail-soft to 0 = rules degrade gracefully)
  let expW = 0;
  try {
    const wx = await getWeather();
    const slot = wx.find(x => x.date === date && x.hour === hour);
    if (slot) expW = expectedPvW(slot.ghi, slot.temp);
  } catch (e) { console.error("weather:", e.message); }
  latest.expW = expW;
  recordHistory(s, expW);

  // Accumulate energy + learn load profile (EMA, α=0.2)
  const hrs = CFG.POLL_MINUTES / 60;
  state.pvWh += s.pv_w * hrs;
  state.expPvWh += expW * hrs;
  state.loadWh += s.load_w * hrs;
  state.dischargeWh += s.discharge_a * s.batt_v * hrs;
  state.chargeWh += s.charge_a * s.batt_v * hrs;
  state.socMin = Math.min(state.socMin, s.soc);
  state.socMax = Math.max(state.socMax, s.soc);

  // Grid import (est) — total for the day, and attributed to whichever meter
  // the changeover is currently on (set via the dashboard).
  const gridEstW = Math.max(0, s.load_w - s.pv_w - s.discharge_a * s.batt_v + s.charge_a * s.batt_v);
  state.gridWh = (state.gridWh || 0) + gridEstW * hrs;
  const activeM = activeMeterId();
  if (activeM) {
    state.meterGridWh = state.meterGridWh || {};
    state.meterGridWh[activeM] = (state.meterGridWh[activeM] || 0) + gridEstW * hrs;
  }
  profile.hourlyLoadW[hour] = profile.seen[hour] === 0 ? s.load_w
    : 0.8 * profile.hourlyLoadW[hour] + 0.2 * s.load_w;
  profile.seen[hour] += 1;

  // Battery health: integrate each continuous discharge segment; a >=15-point
  // SOC drop extrapolates to a full-capacity estimate (median shown in UI).
  const bh = loadJson(CFG.BATT_FILE, { seg: null, estimates: [] });
  if (s.discharge_a > 1) {
    if (!bh.seg) bh.seg = { socStart: s.soc, wh: 0 };
    bh.seg.wh += s.discharge_a * s.batt_v * hrs;
    bh.seg.socEnd = s.soc;
  } else if (bh.seg) {
    const dsoc = bh.seg.socStart - (bh.seg.socEnd ?? bh.seg.socStart);
    if (dsoc >= 15 && bh.seg.wh > 300) {
      bh.estimates.push({ ts: Date.now(), capWh: Math.round(bh.seg.wh / (dsoc / 100)), dsoc, wh: Math.round(bh.seg.wh) });
      while (bh.estimates.length > 200) bh.estimates.shift();
    }
    bh.seg = null;
  }
  saveJson(CFG.BATT_FILE, bh);

  // Curtailment estimate: battery full + sun available but PV throttled →
  // energy net metering would have exported instead of wasting.
  if (s.soc >= 97 && expW > 500 && s.pv_w < expW * 0.85)
    state.curtWh = (state.curtWh || 0) + Math.max(0, expW - s.pv_w) * hrs;

  // Loadshedding tracker: log each grid outage as {start, end}
  if (s.grid_v < 150) {
    if (!state.gridOutStart) state.gridOutStart = Date.now();
  } else if (state.gridOutStart) {
    const outs = loadJson(CFG.OUTAGES_FILE, []);
    outs.push({ start: state.gridOutStart, end: Date.now() });
    while (outs.length > 500) outs.shift();
    saveJson(CFG.OUTAGES_FILE, outs);
    state.gridOutStart = null;
  }

  // TOMZN breaker (real measurement) — closes the inverter's grid-direct blind spot
  try {
    const st = await tuyaStatus();
    if (st) {
      const tp = tuyaParse(st);
      latest.tuya = { ...tp, ts: Date.now() }; latest.tuyaErr = null;
      // Grid-direct (load bypassing the inverter) → true total consumption
      const gEst = Math.max(0, s.load_w - s.pv_w - s.discharge_a * s.batt_v + s.charge_a * s.batt_v);
      const gDirect = tp.power != null ? Math.max(0, tp.power - gEst) : 0;
      state.gridDirectWh = (state.gridDirectWh || 0) + gDirect * hrs;
      // Cumulative kWh delta → today's measured grid + the active meter.
      // Only when role=grid (breaker reads WAPDA import, not total consumption).
      if (CFG.TUYA_ROLE === "grid" && tp.kwh !== null) {
        if (state.tuyaKwhLast != null && tp.kwh >= state.tuyaKwhLast && tp.kwh - state.tuyaKwhLast < 5) {
          const dWh = (tp.kwh - state.tuyaKwhLast) * 1000;
          state.gridMeasWh = (state.gridMeasWh || 0) + dWh;
          const am = activeMeterId();
          if (am) { state.meterMeasWh = state.meterMeasWh || {}; state.meterMeasWh[am] = (state.meterMeasWh[am] || 0) + dWh; }
        }
        state.tuyaKwhLast = tp.kwh;
      }
      // Breaker safety alerts
      if (tp.prepay && tp.balance != null && tp.balance < 15 && shouldFire(state, "prepay_low"))
        await sendAlert(`🟠 BREAKER BALANCE LOW: ${tp.balance.toFixed(1)} units left\nMain breaker auto-cuts the house at 0. Top up (charge_energy) or rotate the changeover.`);
      if (tp.on === false && shouldFire(state, "breaker_off"))
        await sendAlert(`🔴 MAIN BREAKER OFF\nTOMZN reports the house supply is disconnected${tp.prepay && tp.balance != null && tp.balance <= 0 ? " — prepay balance hit 0" : ""}.`);
      if (tp.fault && shouldFire(state, "breaker_fault"))
        await sendAlert(`🔴 BREAKER FAULT (code ${tp.fault})\nCheck the TOMZN — over/under-voltage, over-current, or leakage trip.`);
    }
  } catch (e) { latest.tuyaErr = e.message; console.error("tuya:", e.message); }

  const tW = latest.tuya ? Math.round(latest.tuya.power ?? NaN) : null;
  console.log(`[${new Date().toISOString()}] PV ${Math.round(s.pv_w)}W/${Math.round(expW)}W exp | SOC ${s.soc}% | dis ${s.discharge_a}A | load ${s.load_w}W${tW != null ? ` | grid-meter ${tW}W` : ""} | ${s.mode}`);

  for (const a of runRules(s, state, hour, expW)) await sendAlert(a);

  if (hour === CFG.FORECAST_HOUR && !state.forecastSent) {
    await sendAlert(eveningForecast(s, profile));
    state.forecastSent = true;
  }
  if (hour === CFG.DIGEST_HOUR && !state.digestSent) {
    let extra = "";
    try {
      const wx = await getWeather();
      const tom = tomorrowOutlook(wx, date);
      if (tom) extra += `\n🔮 Tomorrow: ~${tom.kwh.toFixed(1)} units expected (midday clouds ~${tom.cloud}%)`;
      const win = surplusWindow(wx, date);
      if (win) extra += `\n🕐 Heavy-load window tomorrow: ${win.from}:00–${win.to}:00`;
    } catch {}
    const os = outageStats();
    if (os.todayMin > 0) extra += `\n🔌 Loadshedding today: ${os.todayMin} min`;
    if ((state.curtWh || 0) > 200)
      extra += `\n♻️ Curtailed (wasted) today: ${(state.curtWh / 1000).toFixed(1)} units — net metering would export these`;
    const pr = prTrend(loadJson(CFG.DAYS_FILE, []));
    if (pr) extra += `\n📈 7-day PR: ${pr.pr7}%${pr.drift !== null ? ` (${pr.drift >= 0 ? "+" : ""}${pr.drift} vs prev week)` : ""}`;
    const mi = computeMeters();
    for (const m of mi.meters) {
      if (m.noData && !(m.est > 0)) continue;
      extra += `\n${m.active ? "⚡" : "🔢"} ${m.name}: `;
      extra += (!m.noData && m.projected !== null)
        ? `${m.used}u used → proj ${m.projected}/${m.budget} (auto est ~${m.est}u)`
        : `~${m.est}u this cycle (auto est)`;
    }
    await sendAlert(digestText(state) + extra);
    state.digestSent = true;

    // R6b — soiling: weather-adjusted PR drifting down week-over-week
    if (pr && pr.drift !== null && pr.drift <= -8 && pr.pr7 < 75 && shouldFire(state, "soiling"))
      await sendAlert(`🟡 CLEANING SUGGESTED\n7-day PR ${pr.pr7}% (prev week ${pr.prPrev7}%).\nWeather-adjusted output is drifting down — likely soiling/shading.`);

    // R8 — meter budget cliff
    for (const m of mi.meters)
      if (m.status === "red" && shouldFire(state, "meter_" + m.id))
        await sendAlert(`🔴 METER BUDGET: ${m.name}\nProjected ${m.projected} units vs ${m.budget} cap (used ${m.used}, ${mi.cycle.daysLeft}d left in cycle).\nRotate the changeover to another meter.`);
  }

  saveJson(CFG.STATE_FILE, state);
  saveJson(CFG.PROFILE_FILE, profile);

  // Dead-man's switch: ping after every healthy cycle; the monitor service
  // alerts you when pings STOP — i.e. when the watchdog itself dies.
  if (CFG.HEARTBEAT_URL)
    fetch(CFG.HEARTBEAT_URL, { signal: AbortSignal.timeout(10000) }).catch(() => {});
}

// ---------- HTTP DASHBOARD ----------
// GET /            → single-page dashboard (inline, zero-dep)
// GET /api/status  → JSON: live snapshot + today's accumulators + alert log
//                    (this endpoint later becomes the Android app's backend)
async function statusPayload() {
  let expW = latest.expW;
  try {
    const wx = await getWeather();
    const np = nowParts();
    const slot = wx.find(x => x.date === np.date && x.hour === np.hour);
    if (slot) { expW = expectedPvW(slot.ghi, slot.temp); latest.expW = expW; }
  } catch {}
  await liveSnapshot();
  await tuyaLive();
  const s = latest.snapshot;
  const dischargeW = s ? s.discharge_a * s.batt_v : 0;
  const chargeW = s ? s.charge_a * s.batt_v : 0;
  const gridW = s ? Math.round(Math.max(0, s.load_w - s.pv_w - dischargeW + chargeW)) : 0;
  const tuyaW = latest.tuya && latest.tuya.power != null ? latest.tuya.power : null;
  const gridDirectNow = tuyaW != null ? Math.max(0, Math.round(tuyaW - gridW)) : 0;
  const profile = loadJson(CFG.PROFILE_FILE, freshProfile());
  return {
    now: Date.now(), fetchedAt: latest.fetchedAt, freshAt: lastNewDataAt, error: latest.error,
    snapshot: s, expW: Math.round(expW),
    usableWh: s ? Math.round(Math.max(0, (s.soc - CFG.RESERVE_SOC) / 100) * CFG.BATT_WH * 0.92) : 0,
    gridW: gridW,
    battW: Math.round(chargeW - dischargeW),
    tuya: latest.tuya || null, tuyaErr: latest.tuyaErr || null, tuyaRole: CFG.TUYA_ROLE,
    tuyaControl: CFG.TUYA_CONTROL,
    gridDirectW: gridDirectNow, totalW: s ? Math.round(s.load_w + gridDirectNow) : 0,
    pump: (() => { const p = loadPump(); return {
      on: p.on, curRunMin: p.on ? Math.round((Date.now() - p.since) / 60_000) : 0,
      runMinToday: Math.round(p.runMin), energyToday: +(p.energyWh / 1000).toFixed(2),
      lastRun: p.runs.length ? p.runs[p.runs.length - 1] : null, ratedW: CFG.PUMP_W }; })(),
    today: loadJson(CFG.STATE_FILE, null),
    history: history.filter(p => p.t > Date.now() - 48 * 3600_000),
    days: loadJson(CFG.DAYS_FILE, []).slice(-180),
    profile: profile.hourlyLoadW.map(Math.round), seen: profile.seen,
    metersInfo: computeMeters(),
    payback: computePayback(),
    battHealth: computeBattHealth(),
    prTrend: prTrend(loadJson(CFG.DAYS_FILE, [])),
    outages: outageStats(),
    netMetering: netMeteringCase(),
    alerts: alertLog.slice(0, 20),
    cfg: { reserveSoc: CFG.RESERVE_SOC, battWh: CFG.BATT_WH, tz: CFG.TZ,
           tariff: CFG.TARIFF_RS, nmExportRs: CFG.NM_EXPORT_RS },
  };
}

// ---------- REPORTS (day / week / month) ----------
function reportRows(granularity) {
  const all = [...loadJson(CFG.DAYS_FILE, [])];
  const today = loadJson(CFG.STATE_FILE, null);
  if (today && (today.pvWh > 0 || today.loadWh > 0)) all.push({ ...today, partial: true });
  const outs = loadJson(CFG.OUTAGES_FILE, []);
  const outHrsFor = (dateStr) => {
    const start = new Date(`${dateStr}T00:00:00${CFG.UTC_OFFSET}`).getTime();
    const end = start + 86400e3;
    return outs.reduce((s, o) => s + Math.max(0, Math.min(o.end, end) - Math.max(o.start, start)), 0) / 3600e3;
  };
  const keyFor = (d) => {
    if (granularity === "month") return d.date.slice(0, 7);
    if (granularity === "week") { // key = Monday of that week
      const dt = new Date(`${d.date}T12:00:00Z`);
      const mon = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86400e3);
      return mon.toISOString().slice(0, 10);
    }
    return d.date;
  };
  const groups = new Map();
  for (const d of all) {
    const k = keyFor(d);
    if (!groups.has(k)) groups.set(k, { period: k, days: 0, pvWh: 0, expPvWh: 0, loadWh: 0,
      gridWh: 0, dischargeWh: 0, chargeWh: 0, curtWh: 0, outageH: 0, partial: false });
    const g = groups.get(k);
    g.days++;
    g.pvWh += d.pvWh; g.expPvWh += d.expPvWh || 0; g.loadWh += d.loadWh;
    g.gridWh += d.gridWh !== undefined ? d.gridWh
      : Math.max(0, d.loadWh - d.pvWh - (d.dischargeWh || 0) + (d.chargeWh || 0));
    g.dischargeWh += d.dischargeWh || 0; g.chargeWh += d.chargeWh || 0;
    g.curtWh += d.curtWh || 0; g.outageH += outHrsFor(d.date);
    if (d.partial) g.partial = true;
  }
  return [...groups.values()].sort((a, b) => (a.period < b.period ? 1 : -1)).slice(0, 31).map(g => ({
    period: g.period, days: g.days, partial: g.partial,
    gen: +(g.pvWh / 1000).toFixed(1), exp: +(g.expPvWh / 1000).toFixed(1),
    pr: g.expPvWh > 500 ? Math.round(100 * g.pvWh / g.expPvWh) : null,
    load: +(g.loadWh / 1000).toFixed(1), grid: +(g.gridWh / 1000).toFixed(1),
    battOut: +(g.dischargeWh / 1000).toFixed(1), battIn: +(g.chargeWh / 1000).toFixed(1),
    curt: +(g.curtWh / 1000).toFixed(1), outageH: +g.outageH.toFixed(1),
    savedRs: Math.round((g.pvWh / 1000) * CFG.TARIFF_RS),
  }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", c => { b += c; if (b.length > 1e4) req.destroy(); });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

async function handleMeterPost(req, res) {
  res.setHeader("Content-Type", "application/json");
  try {
    const { meter, value, date } = JSON.parse(await readBody(req) || "{}");
    const db = loadMeters();
    const m = db.meters.find(x => x.id === meter);
    const v = Number(value);
    if (!m || !Number.isFinite(v) || v < 0) { res.statusCode = 400; return res.end(JSON.stringify({ error: "bad meter or value" })); }
    // Optional backdating (one-time history import, bill dates): "YYYY-MM-DD"
    let ts = Date.now();
    const backdated = !!date;
    if (backdated) {
      ts = new Date(`${date}T09:00:00${CFG.UTC_OFFSET}`).getTime();
      if (!Number.isFinite(ts)) { res.statusCode = 400; return res.end(JSON.stringify({ error: "bad date — use YYYY-MM-DD" })); }
      if (ts > Date.now()) { res.statusCode = 400; return res.end(JSON.stringify({ error: "date is in the future" })); }
    }
    const rs = db.readings.filter(r => r.meter === meter).sort((a, b) => a.ts - b.ts);
    // Chronological sanity against BOTH neighbours (matters for backfill)
    const before = [...rs].reverse().find(r => r.ts <= ts);
    const after = rs.find(r => r.ts > ts);
    if (before && v < before.value) { res.statusCode = 400; return res.end(JSON.stringify({ error: `below the earlier reading (${before.value}) — meters only count up` })); }
    if (after && v > after.value) { res.statusCode = 400; return res.end(JSON.stringify({ error: `above the later reading (${after.value}) — meters only count up` })); }
    // Idle-meter guard (live logs only): a meter never on the changeover
    // since its last reading should not have moved. Movement = wiring/theft check.
    if (!backdated && before && db.activeLog.length && v - before.value > 3) {
      let wasActive = false;
      for (let i = 0; i < db.activeLog.length; i++) {
        const to = i + 1 < db.activeLog.length ? db.activeLog[i + 1].ts : Date.now();
        if (db.activeLog[i].meter === meter && to > before.ts) wasActive = true;
      }
      if (!wasActive)
        await sendAlert(`🟠 IDLE METER MOVED: ${m.name}\n+${v - before.value} units since last reading, but it was never the active meter.\nCheck the changeover wiring — idle meters should not count.`);
    }
    db.readings.push({ meter, ts, value: v });
    db.readings.sort((a, b) => a.ts - b.ts);
    saveJson(CFG.METERS_FILE, db);
    const info = computeMeters();
    const st = info.meters.find(x => x.id === meter);
    if (st && st.status === "red")
      await sendAlert(`🔴 METER BUDGET: ${st.name}\nProjected ${st.projected} units vs ${st.budget} cap (${info.cycle.daysLeft}d left in cycle).\nRotate the changeover to another meter.`);
    res.end(JSON.stringify({ ok: true, meter: st }));
  } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Solar Watchdog</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#0b0f14">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<style>
:root{--bg:#0b0f14;--card:#121924;--line:#1e2936;--txt:#e7eef6;--dim:#8fa1b3;
--ok:#34d399;--warn:#fbbf24;--bad:#f87171;--accent:#38bdf8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);
font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:22px 16px 48px}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}
h1{font-size:17px;font-weight:650;margin:0;letter-spacing:.01em}
.chip{font-size:12px;font-weight:600;padding:3px 10px;border-radius:99px;
background:#16241d;color:var(--ok);border:1px solid #1e3a2c}
.chip.line{background:#2a2214;color:var(--warn);border-color:#453718}
.live{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;
color:var(--ok);letter-spacing:.12em}
.live i{width:8px;height:8px;border-radius:99px;background:var(--ok);animation:pu 2s infinite}
@keyframes pu{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}
70%{box-shadow:0 0 0 7px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.upd{margin-left:auto;color:var(--dim);font-size:12.5px;text-align:right}
.upd .dot{display:inline-block;width:7px;height:7px;border-radius:99px;
background:var(--ok);margin-right:6px;vertical-align:1px}
.upd.stale .dot{background:var(--bad)}
.cd{color:var(--dim);font-size:11px;font-variant-numeric:tabular-nums}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(215px,1fr))}
.g2{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:15px 16px}
.k{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);margin-bottom:6px}
.v{font-size:29px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.15}
.v small{font-size:15px;font-weight:500;color:var(--dim)}
.sub{color:var(--dim);font-size:12.5px;margin-top:5px}
.bar{height:5px;border-radius:99px;background:#1a2430;margin-top:10px;overflow:hidden}
.bar i{display:block;height:100%;border-radius:99px;background:var(--accent);transition:width .6s}
.soc{display:flex;align-items:center;gap:14px}
.ring{width:64px;height:64px;border-radius:50%;flex:none;display:grid;place-items:center;
font-size:15px;font-weight:650;font-variant-numeric:tabular-nums}
.ring b{background:var(--card);width:50px;height:50px;border-radius:50%;
display:grid;place-items:center;font-weight:650}
.rows{display:grid;gap:8px}
.row{display:flex;justify-content:space-between;font-size:13.5px;gap:10px}
.row span:first-child{color:var(--dim)}
.row b{font-variant-numeric:tabular-nums;white-space:nowrap}
.st{display:inline-block;width:8px;height:8px;border-radius:99px;margin-right:7px;vertical-align:0}
.st.ok{background:var(--ok)}.st.bad{background:var(--bad)}
.frow{display:flex;justify-content:space-between;align-items:center;gap:10px;
padding:9px 2px;border-bottom:1px solid var(--line);font-size:14px}
.frow:last-child{border-bottom:none}
.frow .val{font-variant-numeric:tabular-nums;font-weight:650;white-space:nowrap}
.frow.on .val{color:var(--accent)}
.frow.chg .val{color:var(--ok)}
.frow.warn .val{color:var(--warn)}
.frow.bad .val{color:var(--bad)}
.frow.off{opacity:.45}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px;font-size:12px;color:var(--dim)}
.legend i{display:inline-block;width:10px;height:3px;border-radius:2px;margin-right:5px;vertical-align:2px}
.alerts{margin-top:2px}
.alert{padding:10px 12px;border:1px solid var(--line);border-radius:10px;
margin-bottom:8px;font-size:13.5px;white-space:pre-line}
.alert time{display:block;color:var(--dim);font-size:11.5px;margin-bottom:3px}
.empty{color:var(--dim);font-size:13.5px;padding:6px 2px}
section{margin-top:22px}
h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);
font-weight:600;margin:0 0 10px}
.verdict{font-size:14px;margin-top:10px}
.tbtn{background:transparent;border:1px solid var(--line);color:var(--dim);
border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer}
.tbtn.on{background:#14283c;border-color:#24405c;color:var(--accent);font-weight:600}
table{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
th:first-child,td:first-child{text-align:left}
tr:last-child td{border-bottom:none}
</style></head><body><div class="wrap">
<header>
  <h1>☀️ Solar Watchdog</h1>
  <span class="chip" id="mode">—</span>
  <span class="live"><i></i>LIVE</span>
  <span class="upd" id="upd"><span class="dot"></span>connecting…<br>
  <span class="cd" id="cd"></span></span>
</header>

<div class="grid">
  <div class="card"><div class="k">Solar Now</div>
    <div class="v" id="pv">—</div>
    <div class="sub" id="pvsub">expected —</div>
    <div class="bar"><i id="prbar" style="width:0%"></i></div></div>
  <div class="card"><div class="k">Battery</div>
    <div class="soc"><div class="ring" id="ring"><b id="soc">—</b></div>
    <div><div class="v" id="battflow" style="font-size:19px">—</div>
    <div class="sub" id="battsub">—</div></div></div></div>
  <div class="card"><div class="k">Total Consumption</div>
    <div class="v" id="load">—</div>
    <div class="sub" id="gridsub">grid —</div></div>
  <div class="card"><div class="k">Today</div>
    <div class="v" id="units">—<small> units</small></div>
    <div class="sub" id="todaysub">—</div></div>
  <div class="card" id="pb_card" style="display:none"><div class="k">Payback</div>
    <div class="v" id="pb_v" style="font-size:24px">—</div>
    <div class="sub" id="pb_sub">—</div>
    <div class="bar"><i id="pb_bar" style="width:0%;background:var(--ok)"></i></div></div>
</div>

<section><h2>Power Flow</h2><div class="card">
  <div class="frow" id="f_solar"><span>☀️ Solar</span><span class="val" id="f_solar_v">—</span></div>
  <div class="frow" id="f_batt"><span>🔋 Battery</span><span class="val" id="f_batt_v">—</span></div>
  <div class="frow" id="f_grid"><span>⚡ Grid (inverter est)</span><span class="val" id="f_grid_v">—</span></div>
  <div class="frow" id="f_meter" style="display:none"><span>📟 Grid Meter (TOMZN)</span><span class="val" id="f_meter_v">—</span></div>
</div></section>

<section><h2>Today's Energy Sources</h2><div class="card">
  <div id="mix"><div class="empty">Gathering today's energy…</div></div>
</div></section>

<section><h2>Consumption History</h2><div class="card">
  <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">
    <button class="tbtn on" data-r="12h" onclick="setRange(this.dataset.r)">12h</button>
    <button class="tbtn" data-r="24h" onclick="setRange(this.dataset.r)">24h</button>
    <button class="tbtn" data-r="48h" onclick="setRange(this.dataset.r)">48h</button>
    <button class="tbtn" data-r="7d" onclick="setRange(this.dataset.r)">7d</button>
    <button class="tbtn" data-r="30d" onclick="setRange(this.dataset.r)">30d</button>
    <button class="tbtn" data-r="all" onclick="setRange(this.dataset.r)">All</button>
  </div>
  <div class="legend" id="hist_legend"></div>
  <div id="chart"><div class="empty">Collecting data…</div></div>
</div></section>

<div class="g2" style="margin-top:22px">
  <div><h2>Strings</h2><div class="card"><div class="rows">
    <div class="row"><span><i class="st ok" id="st1"></i>PV1 · 8×585W</span><b id="pv1">—</b></div>
    <div class="row"><span><i class="st ok" id="st2"></i>PV2 · 6×620W (watch)</span><b id="pv2">—</b></div>
  </div></div></div>
  <div><h2>System</h2><div class="card"><div class="rows">
    <div class="row"><span>Battery voltage</span><b id="sy_bv">—</b></div>
    <div class="row"><span>Battery current</span><b id="sy_ba">—</b></div>
    <div class="row"><span>Grid voltage</span><b id="sy_gv">—</b></div>
    <div class="row"><span>Usable above reserve</span><b id="sy_us">—</b></div>
    <div class="row"><span>Battery capacity (est.)</span><b id="sy_cap">learning…</b></div>
    <div class="row"><span>7-day performance</span><b id="sy_pr">collecting…</b></div>
  </div></div></div>
</div>

<section id="brk_section" style="display:none"><h2>Main Breaker — TOMZN (all settings)</h2>
<div class="g2">
  <div class="card"><div class="k">Prepay Cutoff Balance</div>
    <div class="v" id="brk_bal">—</div>
    <div class="sub" id="brk_bal_sub">units remaining before auto-disconnect</div>
    <div class="bar"><i id="brk_bal_bar" style="width:0%"></i></div></div>
  <div class="card"><div class="k">Live</div><div class="rows" id="brk_live" style="margin-top:8px"></div></div>
</div>
<div class="card" style="margin-top:12px"><div class="k">Configuration &amp; Protection</div>
  <div class="rows" id="brk_cfg" style="margin-top:10px"></div>
  <div id="brk_controls" style="display:none;margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
    <div class="k">Controls</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:9px;align-items:center">
      <button class="tbtn" onclick="breakerCmd('supply',true)">Supply ON</button>
      <button class="tbtn" style="border-color:#5c2424;color:#f87171" onclick="breakerCmd('supply',false,'Turn OFF the whole-house supply? This blacks out the house.')">Supply OFF</button>
      <button class="tbtn" onclick="breakerCmd('protect',null,'Top up the breaker so it cuts at the active meter&#39;s budget?')">Set for active meter</button>
      <input id="brk_topup" type="number" inputmode="numeric" placeholder="units" style="width:78px;background:#0e141c;border:1px solid var(--line);border-radius:8px;color:var(--txt);padding:5px 8px;font-size:13px">
      <button class="tbtn" onclick="topupBreaker()">Top up</button>
    </div>
    <div class="sub" id="brk_ctl_msg" style="margin-top:8px"></div>
  </div>
</div></section>

<section><h2>FESCO Meters <span id="mcycle" style="text-transform:none;letter-spacing:0;font-weight:400"></span></h2>
<div class="grid" id="meters"><div class="empty">Loading…</div></div></section>

<section><h2>Decision Support</h2><div class="grid">
  <div class="card"><div class="k">Loadshedding</div>
    <div class="v" id="out_v" style="font-size:22px">—</div>
    <div class="sub" id="out_sub">tracking grid outages via grid voltage</div></div>
  <div class="card"><div class="k">Net-Metering Case</div>
    <div class="v" id="nm_v" style="font-size:22px">—</div>
    <div class="sub" id="nm_sub">curtailed solar the grid could be buying</div></div>
  <div class="card" id="pump_card" style="display:none"><div class="k">Water Pump (inferred)</div>
    <div class="v" id="pump_v" style="font-size:22px">—</div>
    <div class="sub" id="pump_sub">detected from the ~2kW grid-load signature</div></div>
</div></section>


<section><h2>Evening Plan (19:00–24:00)</h2><div class="card">
  <div class="rows">
    <div class="row"><span>Battery available now</span><b id="ev_have">—</b></div>
    <div class="row"><span>Typical evening load</span><b id="ev_need">—</b></div>
  </div>
  <div class="verdict" id="ev_verdict">—</div>
</div></section>

<section><h2>Reports — Solar · Battery · Grid</h2><div class="card">
  <div style="display:flex;gap:6px;margin-bottom:12px">
    <button class="tbtn on" data-g="day" onclick="loadReport(this.dataset.g)">Daily</button>
    <button class="tbtn" data-g="week" onclick="loadReport(this.dataset.g)">Weekly</button>
    <button class="tbtn" data-g="month" onclick="loadReport(this.dataset.g)">Monthly</button>
  </div>
  <div id="report" style="overflow-x:auto"><div class="empty">Loading…</div></div>
</div></section>

<section><h2>Alerts</h2><div class="alerts" id="alerts">
  <div class="empty">Loading…</div></div></section>
</div>

<script>
var REFRESH = 30, cd = REFRESH;
function fmtW(w){ return Math.abs(w) >= 1000 ? (w/1000).toFixed(2) + ' kW' : Math.round(w) + ' W'; }
function ago(ts){ var m = (Date.now()-ts)/60000;
  return m < 1 ? 'just now' : m < 60 ? Math.round(m) + ' min ago' : (m/60).toFixed(1) + ' h ago'; }
function el(id){ return document.getElementById(id); }
function setFlow(id, cls, text){ el(id).className = 'frow ' + cls; el(id + '_v').textContent = text; }

function renderMeters(info){
  el('mcycle').textContent = '· ' + info.cycle.daysLeft + ' days left in cycle (7th → 7th)' +
    (info.active ? '' : ' · tap SET ACTIVE on the meter your changeover is on');
  el('meters').innerHTML = info.meters.map(function(m){
    var col = m.status === 'red' ? 'var(--bad)' : m.status === 'amber' ? 'var(--warn)' : 'var(--ok)';
    var autoU = m.measured ? m.meas : m.est;
    var auto = autoU > 0 ? '<div class="sub">' +
      (m.measured ? '📟 measured grid this cycle: ' : 'auto grid est this cycle: ~') + autoU + ' u' +
      (m.perDay !== null && m.perDay !== undefined ? ' · ~' + m.perDay + ' u/day from readings' : '') + '</div>' : '';
    var prot = '';
    if (m.prot){
      // this cycle counts as the next clean bill if it's projecting/pacing ≤ budget
      var cycleClean = m.status ? m.status !== 'red' : (m.used_auto <= m.budget);
      if (m.protected){
        prot = '<div class="sub" style="color:var(--ok)">🛡 protected · stay ≤ ' + m.budget + '</div>';
      } else if (m.prot.streak >= 6){
        prot = '<div class="sub" style="color:var(--ok)">🛡 criteria met — 6 clean bills ✓ · protected at next bill</div>';
      } else if (m.prot.streak === 5 && cycleClean && !m.prot.liveReset){
        prot = '<div class="sub" style="color:var(--ok)">🛡 on track — keep this cycle ≤ ' + m.budget + ' to lock protection (5/6)</div>';
      } else {
        prot = '<div class="sub" style="color:' + (m.prot.streak > 0 ? 'var(--warn)' : 'var(--bad)') + '">' +
          '🛡 in ' + m.prot.needed + ' clean bill' + (m.prot.needed === 1 ? '' : 's') +
          ' (streak ' + m.prot.streak + '/6 · protected after ' + m.prot.eta + ' bill)' +
          (m.prot.liveReset ? ' — THIS cycle >200, streak resets' : '') + '</div>';
      }
    }
    var body;
    if (m.noData){
      body = '<div class="sub" style="margin:8px 0 2px">no readings yet — log the 7th-of-month baseline</div>' + auto + prot;
    } else if (m.projected === null){
      body = '<div class="v" style="font-size:22px">' + m.used + '<small> used</small></div>' +
        '<div class="sub">baseline ' + m.lastValue + ' set · log again in a few days for a projection</div>' + auto + prot;
    } else {
      body = '<div class="v" style="font-size:22px">' + m.used + '<small> used → ' + m.projected + ' projected</small></div>' +
        '<div class="sub">budget ' + m.budget + ' · last reading ' + m.lastValue +
        (m.midCycleBaseline ? ' · partial (mid-cycle baseline)' : '') + '</div>' + auto + prot +
        '<div class="bar"><i style="width:' + Math.min(100, Math.round(100*m.projected/m.budget)) + '%;background:' + col + '"></i></div>';
    }
    var actBtn = m.active
      ? '<span style="align-self:center;font-size:11px;font-weight:700;color:var(--ok);letter-spacing:.06em;white-space:nowrap">⚡ ACTIVE</span>'
      : '<button data-m="' + m.id + '" onclick="setActive(this.dataset.m)" ' +
        'style="background:transparent;border:1px solid var(--line);color:var(--dim);border-radius:8px;padding:6px 9px;font-size:11px;cursor:pointer;white-space:nowrap">SET ACTIVE</button>';
    return '<div class="card"' + (m.active ? ' style="border-color:#2b5e46"' : '') + '><div class="k">' +
      m.name + (m.protected ? ' 🛡 protected' : (m.prot && m.prot.streak >= 6 ? ' 🛡 criteria met' : '')) + '</div>' +
      (m.ref ? '<div class="sub" style="margin:-2px 0 8px;font-variant-numeric:tabular-nums">Ref ' + m.ref +
        (m.sp ? ' · Meter S-P ' + m.sp : '') + '</div>' : '') + body +
      '<div style="display:flex;gap:6px;margin-top:10px">' +
      '<input id="mi_' + m.id + '" type="number" inputmode="numeric" placeholder="meter reading" ' +
      'style="flex:1;min-width:0;background:#0e141c;border:1px solid var(--line);border-radius:8px;color:var(--txt);padding:6px 9px;font-size:13px">' +
      '<button data-m="' + m.id + '" onclick="logMeter(this.dataset.m)" ' +
      'style="background:#14283c;border:1px solid #24405c;color:var(--accent);border-radius:8px;padding:6px 12px;font-size:12.5px;cursor:pointer">Log</button>' +
      actBtn + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:6px;align-items:center">' +
      '<input id="md_' + m.id + '" type="date" ' +
      'style="background:#0e141c;border:1px solid var(--line);border-radius:8px;color:var(--dim);padding:4px 8px;font-size:12px">' +
      '<span class="sub" style="margin:0">optional — backdate (bill / past reading)</span>' +
      '</div></div>';
  }).join('');
}

var repG = 'day';
async function loadReport(g){
  if (g) repG = g;
  document.querySelectorAll('.tbtn').forEach(function(b){
    b.className = 'tbtn' + (b.dataset.g === repG ? ' on' : ''); });
  var d = await (await fetch('/api/report?g=' + repG)).json();
  var box = el('report');
  if (!d.rows.length){
    box.innerHTML = '<div class="empty">No completed days yet — rows appear after each midnight.</div>';
    return;
  }
  var label = repG === 'day' ? 'Date' : repG === 'week' ? 'Week of' : 'Month';
  var h = '<table><tr><th>' + label + '</th><th>Solar u</th><th>Expected</th><th>PR%</th>' +
    '<th>House u</th><th>Grid u</th><th>Batt out</th><th>Batt in</th>' +
    '<th>Wasted</th><th>Outage h</th><th>Saved Rs</th></tr>';
  d.rows.forEach(function(r){
    h += '<tr><td>' + r.period + (r.partial ? ' •' : '') + '</td>' +
      '<td><b style="color:var(--accent)">' + r.gen + '</b></td>' +
      '<td>' + r.exp + '</td>' +
      '<td>' + (r.pr === null ? '—' : '<span style="color:' + (r.pr >= 65 ? 'var(--ok)' : 'var(--bad)') + '">' + r.pr + '</span>') + '</td>' +
      '<td>' + r.load + '</td><td>' + r.grid + '</td>' +
      '<td>' + r.battOut + '</td><td>' + r.battIn + '</td>' +
      '<td>' + (r.curt > 0 ? '<span style="color:var(--warn)">' + r.curt + '</span>' : '0') + '</td>' +
      '<td>' + r.outageH + '</td><td>' + r.savedRs.toLocaleString() + '</td></tr>';
  });
  box.innerHTML = h + '</table><div class="sub" style="margin-top:8px">• period still in progress · units = kWh · saved @ Rs ' +
    (window.__tariff || 45) + '/unit</div>';
}

async function setActive(id){
  await fetch('/api/meter/active', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meter: id }) });
  load();
}

async function breakerCmd(action, value, confirmMsg){
  if (confirmMsg && !confirm(confirmMsg)) return;
  var msg = el('brk_ctl_msg'); if (msg) msg.textContent = 'sending…';
  try {
    var r = await fetch('/api/breaker', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action, value: value }) });
    var j = await r.json();
    if (j.error) { if (msg) msg.textContent = '⚠️ ' + j.error; }
    else { if (msg) msg.textContent = '✅ ' + (j.note || 'done'); setTimeout(load, 1500); }
  } catch(e){ if (msg) msg.textContent = '⚠️ ' + e.message; }
}
function topupBreaker(){
  var n = el('brk_topup').value;
  if (n) breakerCmd('topup', Number(n), 'Add ' + n + ' units to the breaker balance?');
}

function drawDailyChart(days){
  if (!days || !days.length){ el('chart').innerHTML = '<div class="empty">No completed days yet — daily bars appear after midnight.</div>'; return; }
  var W = 820, H = 250, L = 36, R = 10, B = 24, T = 16;
  var n = days.length, slot = (W-L-R) / n, bw = Math.max(4, Math.floor(slot) - 4);
  var cons = function(d){ return (d.loadWh + (d.gridDirectWh || 0)) / 1000; }; // true total consumption
  var max = 1;
  days.forEach(function(d){ max = Math.max(max, d.pvWh/1000, cons(d)); });
  max *= 1.15;
  function Y(kwh){ return H-B - (H-B-T) * (kwh/max); }
  var grid = '', yl = '';
  for (var g = 0; g <= 3; g++){
    var yv = max * g / 3, y = Y(yv);
    grid += '<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W-R) + '" y2="' + y.toFixed(1) + '" stroke="#1e2936" stroke-width="1"/>';
    yl += '<text x="' + (L-6) + '" y="' + (y+3).toFixed(1) + '" fill="#8fa1b3" font-size="10" text-anchor="end">' + yv.toFixed(0) + '</text>';
  }
  var svg = '', step = Math.max(1, Math.ceil(n/9)), half = bw/2;
  days.forEach(function(d, i){
    var x = L + i * slot + 2, gen = d.pvWh/1000, use = cons(d), grd = (d.gridMeasWh || d.gridWh || 0)/1000;
    // generation bar (left half) + consumption bar (right half)
    svg += '<rect x="' + x.toFixed(1) + '" y="' + Y(gen).toFixed(1) + '" width="' + half + '" height="' + Math.max(1,(H-B)-Y(gen)).toFixed(1) + '" fill="#38bdf8" opacity=".9"/>';
    svg += '<rect x="' + (x+half).toFixed(1) + '" y="' + Y(use).toFixed(1) + '" width="' + half + '" height="' + Math.max(1,(H-B)-Y(use)).toFixed(1) + '" fill="#fbbf24" opacity=".85"/>';
    svg += '<rect x="' + x.toFixed(1) + '" y="' + Y(grd).toFixed(1) + '" width="' + bw + '" height="1.5" fill="#f472b6"/>';
    if (i === 0 || i === n-1 || i % step === 0)
      svg += '<text x="' + (x + half).toFixed(1) + '" y="' + (H-6) + '" fill="#8fa1b3" font-size="9" text-anchor="middle">' + d.date.slice(5) + '</text>';
  });
  el('chart').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto">' +
    grid + yl + '<text x="4" y="11" fill="#8fa1b3" font-size="10">kWh</text>' + svg + '</svg>';
}

var histRange = '12h';
function setRange(r){
  histRange = r;
  document.querySelectorAll('[data-r]').forEach(function(b){ b.className = 'tbtn' + (b.dataset.r === r ? ' on' : ''); });
  if (window.__data) drawHistory(window.__data);
}
function drawHistory(d){
  var fine = { '12h': 12, '24h': 24, '48h': 48 };
  if (fine[histRange]){
    var since = Date.now() - fine[histRange] * 3600000;
    drawFineChart((d.history || []).filter(function(p){ return p.t > since; }));
    el('hist_legend').innerHTML = legendHtml([['#38bdf8','Solar'],['#8fa1b3','Expected'],['#f472b6','Total use'],['#fbbf24','Inverter load'],['#34d399','SOC']]);
  } else {
    var nDays = histRange === '7d' ? 7 : histRange === '30d' ? 30 : 999;
    drawDailyChart((d.days || []).slice(-nDays));
    el('hist_legend').innerHTML = legendHtml([['#38bdf8','Generated'],['#fbbf24','Consumed'],['#f472b6','Grid']]);
  }
}

async function logMeter(id){
  var inp = el('mi_' + id);
  if (!inp.value) return;
  var dt = el('md_' + id).value;
  var r = await fetch('/api/meter', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meter: id, value: Number(inp.value), date: dt || undefined }) });
  var j = await r.json();
  if (j.error) { alert(j.error); } else { load(); }
}

function fmtKw(w){ return w >= 1000 ? (w/1000).toFixed(1) + 'k' : String(Math.round(w)); }
function legendHtml(items){ return items.map(function(it){ return '<span><i style="background:'+it[0]+'"></i>'+it[1]+'</span>'; }).join(''); }
function drawFineChart(hist){
  if (!hist || hist.length < 2){
    el('chart').innerHTML = '<div class="empty">Collecting data… (chart fills in as the logger uploads)</div>';
    return;
  }
  var W = 820, H = 250, L = 44, R = 12, B = 24, T = 12;
  var t0 = hist[0].t, t1 = hist[hist.length-1].t;
  var ymax = 600;
  hist.forEach(function(p){ ymax = Math.max(ymax, p.pv, p.exp, p.load, p.total || 0); });
  ymax *= 1.1;
  function X(t){ return L + (W-L-R) * (t-t0) / Math.max(1, t1-t0); }
  function Y(v){ return H-B - (H-B-T) * (v/ymax); }
  function Ys(soc){ return H-B - (H-B-T) * (soc/100); }
  function path(key){ return hist.map(function(p,i){
    var v = key === 'total' ? (p.total != null ? p.total : p.load) : p[key];
    return (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(v).toFixed(1); }).join(' '); }
  // y-axis: left = Watts, right = SOC %
  var grid = '', yl = '';
  for (var g = 0; g <= 4; g++){
    var yv = ymax * g / 4, y = Y(yv);
    grid += '<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W-R) + '" y2="' + y.toFixed(1) + '" stroke="#1e2936" stroke-width="1"/>';
    yl += '<text x="' + (L-6) + '" y="' + (y+3).toFixed(1) + '" fill="#8fa1b3" font-size="10" text-anchor="end">' + fmtKw(yv) + '</text>';
    yl += '<text x="' + (W-R+4) + '" y="' + (y+3).toFixed(1) + '" fill="#34d399" font-size="10" text-anchor="start">' + Math.round(100*g/4) + '</text>';
  }
  var area = path('pv') + ' L' + X(t1).toFixed(1) + ' ' + (H-B) + ' L' + X(t0).toFixed(1) + ' ' + (H-B) + ' Z';
  var socPath = hist.map(function(p,i){
    return (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Ys(p.soc).toFixed(1); }).join(' ');
  var xl = '';
  for (var k = 0; k <= 4; k++){
    var tt = t0 + (t1-t0) * k / 4;
    var anchor = k === 0 ? 'start' : k === 4 ? 'end' : 'middle';
    xl += '<text x="' + X(tt).toFixed(0) + '" y="' + (H-7) + '" fill="#8fa1b3" font-size="10" text-anchor="' + anchor + '">' +
      new Date(tt).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'}) + '</text>';
  }
  el('chart').innerHTML =
    '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block">' + grid +
    '<text x="' + (L-6) + '" y="9" fill="#8fa1b3" font-size="9" text-anchor="end">W</text>' +
    '<text x="' + (W-R+4) + '" y="9" fill="#34d399" font-size="9" text-anchor="start">%</text>' +
    '<path d="' + area + '" fill="rgba(56,189,248,.12)"/>' +
    '<path d="' + path('pv') + '" stroke="#38bdf8" fill="none" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="' + path('exp') + '" stroke="#8fa1b3" fill="none" stroke-width="1.5" stroke-dasharray="5 4"/>' +
    '<path d="' + path('total') + '" stroke="#f472b6" fill="none" stroke-width="2"/>' +
    '<path d="' + path('load') + '" stroke="#fbbf24" fill="none" stroke-width="1.5" opacity=".8"/>' +
    '<path d="' + socPath + '" stroke="#34d399" fill="none" stroke-width="1.5" opacity=".85"/>' +
    yl + xl + '</svg>';
}

// Pie of today's energy sources — each slice direct-labeled (name · kWh · %)
function drawPie(parts){
  var total = parts.reduce(function(s,p){ return s + Math.max(0,p.val); }, 0);
  if (total <= 0.05){ el('mix').innerHTML = '<div class="empty">No energy recorded yet today.</div>'; return; }
  var cx = 90, cy = 90, r = 78, ang = -Math.PI/2, svg = '';
  parts.forEach(function(p){
    if (p.val <= 0) return;
    var frac = p.val/total, a2 = ang + frac*2*Math.PI;
    if (frac >= 0.999){ svg += '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="'+p.color+'"/>'; ang = a2; return; }
    var x1 = cx+r*Math.cos(ang), y1 = cy+r*Math.sin(ang), x2 = cx+r*Math.cos(a2), y2 = cy+r*Math.sin(a2);
    svg += '<path d="M'+cx+' '+cy+' L'+x1.toFixed(1)+' '+y1.toFixed(1)+' A'+r+' '+r+' 0 '+(frac>0.5?1:0)+' 1 '+x2.toFixed(1)+' '+y2.toFixed(1)+' Z" fill="'+p.color+'" stroke="var(--card)" stroke-width="2"/>';
    ang = a2;
  });
  var legend = parts.filter(function(p){ return p.val > 0; }).map(function(p){
    return '<div class="row"><span><i class="st" style="background:'+p.color+'"></i>'+p.label+'</span>' +
      '<b>'+p.val.toFixed(1)+' kWh · '+Math.round(100*p.val/total)+'%</b></div>';
  }).join('');
  el('mix').innerHTML = '<div style="display:flex;gap:22px;align-items:center;flex-wrap:wrap">' +
    '<svg viewBox="0 0 180 180" style="width:170px;height:170px;flex:none">'+svg+'</svg>' +
    '<div class="rows" style="flex:1;min-width:210px">'+legend+
    '<div class="sub" style="margin-top:6px">battery figure is stored solar released later</div></div></div>';
}

async function load(){
  var d;
  try { d = await (await fetch('/api/status')).json(); }
  catch(e){ el('upd').innerHTML = 'dashboard unreachable'; cd = REFRESH; return; }
  cd = REFRESH;
  var s = d.snapshot;
  var upd = el('upd');
  if (!s){ upd.className = 'upd stale';
    upd.innerHTML = '<span class="dot"></span>' + (d.error || 'no data yet') +
      '<br><span class="cd" id="cd"></span>'; return; }
  var dataTs = d.freshAt || d.fetchedAt; // when the inverter reading last changed
  upd.className = 'upd' + (Date.now()-dataTs > 30*60000 ? ' stale' : '');
  upd.innerHTML = '<span class="dot"></span>reading ' + ago(dataTs) +
    ' · inverter uploads ~5 min<br><span class="cd" id="cd"></span>';

  var mode = el('mode');
  mode.textContent = s.mode;
  mode.className = 'chip' + (/line|utility|mains/i.test(s.mode) ? ' line' : '');

  el('pv').textContent = fmtW(s.pv_w);
  var pct = d.expW > 100 ? Math.round(100*s.pv_w/d.expW) : null;
  el('pvsub').textContent =
    d.expW > 0 ? 'expected ~' + fmtW(d.expW) + (pct !== null ? ' · ' + pct + '%' : '') : 'night / no sun expected';
  el('prbar').style.width = Math.min(100, pct || 0) + '%';
  el('prbar').style.background = pct === null || pct >= 65 ? 'var(--accent)' : 'var(--bad)';

  el('soc').textContent = Math.round(s.soc) + '%';
  el('ring').style.background = 'conic-gradient(var(--ok) ' + (s.soc*3.6) + 'deg, #1a2430 0)';
  var flow = s.charge_a > 0.5 ? '⬆ ' + s.charge_a.toFixed(1) + ' A in'
           : s.discharge_a > 0.5 ? '⬇ ' + s.discharge_a.toFixed(1) + ' A out' : 'idle';
  el('battflow').textContent = flow;
  el('battsub').textContent =
    (d.usableWh/1000).toFixed(1) + ' kWh usable above ' + d.cfg.reserveSoc + '% · ' + s.batt_v.toFixed(1) + ' V';

  el('load').textContent = fmtW(d.totalW || s.load_w);
  el('gridsub').textContent = d.gridDirectW > 30
    ? 'inverter ' + fmtW(s.load_w) + ' + grid-direct ' + fmtW(d.gridDirectW)
    : 'all via inverter · ' + (s.grid_v > 150 ? 'grid present' : 'grid down');

  // Power flow lanes
  setFlow('f_solar', s.pv_w > 50 ? 'on' : 'off',
    s.pv_w > 50 ? fmtW(s.pv_w) + (d.battW > 50 ? ' → house + battery' : ' → house') : 'asleep');
  setFlow('f_batt',
    d.battW > 50 ? 'chg' : d.battW < -50 ? 'warn' : 'off',
    d.battW > 50 ? '⬆ charging ' + fmtW(d.battW)
      : d.battW < -50 ? '⬇ powering house ' + fmtW(-d.battW) : 'idle');
  setFlow('f_grid',
    s.grid_v <= 150 ? 'bad' : d.gridW > 50 ? 'warn' : 'off',
    s.grid_v <= 150 ? 'DOWN — on battery' : d.gridW > 50 ? 'importing ' + fmtW(d.gridW) : 'standby ~0 W');
  if (d.tuya && d.tuya.power !== null && d.tuya.power !== undefined){
    el('f_meter').style.display = '';
    setFlow('f_meter', d.tuya.power > 50 ? 'warn' : 'off',
      fmtW(d.tuya.power) + (d.tuya.voltage ? ' · ' + Math.round(d.tuya.voltage) + 'V' : '') +
      (d.today && d.today.gridMeasWh ? ' · ' + (d.today.gridMeasWh/1000).toFixed(1) + 'u today' : ''));
  } else if (d.tuyaErr){
    el('f_meter').style.display = '';
    setFlow('f_meter', 'bad', 'not reading — ' + d.tuyaErr);
  }

  window.__data = d;
  drawHistory(d);

  var t = d.today;
  if (t){
    var pvU = t.pvWh/1000, expU = t.expPvWh/1000;
    el('units').innerHTML = pvU.toFixed(1) + '<small> units</small>';
    el('todaysub').textContent =
      (expU > 0.2 ? Math.round(100*pvU/expU) + '% of expected · ' : '') +
      'saved ~Rs. ' + Math.round(pvU*d.cfg.tariff).toLocaleString() +
      (t.gridWh !== undefined ? ' · grid ~' + (t.gridWh/1000).toFixed(1) + 'u' : '') +
      (t.socMax >= t.socMin ? ' · SOC ' + t.socMin + '–' + t.socMax + '%' : '');
  }

  if (d.payback){
    el('pb_card').style.display = '';
    el('pb_v').textContent = 'Rs ' + d.payback.savedRs.toLocaleString();
    el('pb_sub').textContent = d.payback.pct + '% of Rs ' + d.payback.costRs.toLocaleString() +
      (d.payback.yearsLeft !== null ? ' · ~' + d.payback.yearsLeft + ' yr left' : '');
    el('pb_bar').style.width = d.payback.pct + '%';
  }

  el('sy_cap').textContent = d.battHealth.samples
    ? (d.battHealth.capWh/1000).toFixed(2) + ' kWh (' + d.battHealth.pct + '% of rated) · ' + d.battHealth.samples + ' samples'
    : 'learning — needs a deep discharge';
  el('sy_pr').textContent = d.prTrend
    ? d.prTrend.pr7 + '%' + (d.prTrend.drift !== null
        ? ' (' + (d.prTrend.drift >= 0 ? '+' : '') + d.prTrend.drift + ' vs prev wk)' : '')
    : 'collecting… (needs 3+ days)';

  renderMeters(d.metersInfo);

  if (d.outages){
    el('out_v').textContent = d.outages.todayMin + ' min today' + (d.outages.ongoing ? ' · OUT NOW' : '');
    el('out_sub').textContent = d.outages.weekHrs + ' h across ' + d.outages.weekCount + ' outages in 7 days';
  }
  if (d.netMetering){
    el('nm_v').textContent = d.netMetering.curtKwh + ' units wasted';
    el('nm_sub').textContent = 'last ' + d.netMetering.nDays + 'd · ≈ Rs ' +
      d.netMetering.rsYear.toLocaleString() + '/yr at Rs ' + d.cfg.nmExportRs + '/unit export';
  }
  if (d.pump){
    el('pump_card').style.display = '';
    el('pump_v').innerHTML = d.pump.on
      ? '<span style="color:var(--warn)">⚙️ RUNNING ' + d.pump.curRunMin + ' min</span>' : 'idle';
    el('pump_sub').textContent = 'today: ' + d.pump.runMinToday + ' min · ~' + d.pump.energyToday + ' kWh' +
      (d.pump.lastRun ? ' · last run ' + d.pump.lastRun.min + ' min' : '');
  }

  if (d.today){
    drawPie([
      { label: '☀️ Solar generated', val: d.today.pvWh/1000, color: '#38bdf8' },
      { label: '🔋 Battery discharged', val: d.today.dischargeWh/1000, color: '#34d399' },
      { label: '⚡ Grid imported', val: (d.today.gridMeasWh || d.today.gridWh || 0)/1000, color: '#fbbf24' },
    ]);
  }

  if (d.tuya){
    el('brk_section').style.display = '';
    var tk = d.tuya, CUT = 180;
    if (tk.prepay && tk.balance !== null){
      el('brk_bal').textContent = tk.balance.toFixed(1) + ' u';
      el('brk_bal_bar').style.width = Math.min(100, 100*tk.balance/CUT) + '%';
      el('brk_bal_bar').style.background = tk.balance < 15 ? 'var(--bad)' : tk.balance < 40 ? 'var(--warn)' : 'var(--ok)';
      el('brk_bal_sub').textContent = 'units until auto-disconnect · prepay ON';
    } else {
      el('brk_bal').textContent = 'OFF';
      el('brk_bal_sub').textContent = 'prepayment off — no auto cutoff';
    }
    el('brk_live').innerHTML = [
      ['Supply', '<b style="color:' + (tk.on === false ? 'var(--bad)' : 'var(--ok)') + '">' + (tk.on === false ? 'OFF' : 'ON') + '</b>'],
      ['Voltage', tk.voltage !== null ? tk.voltage.toFixed(1) + ' V' : '—'],
      ['Current', tk.current !== null ? tk.current.toFixed(2) + ' A' : '—'],
      ['Power', tk.power !== null ? fmtW(tk.power) : '—'],
      ['Power factor', tk.pf !== null ? tk.pf : '—'],
      ['Frequency', tk.freq !== null ? tk.freq.toFixed(1) + ' Hz' : '—'],
      ['Leakage current', tk.leakage !== null ? tk.leakage + ' mA' : '—'],
      ['Total through breaker', tk.kwh !== null ? tk.kwh.toFixed(2) + ' kWh' : '—'],
    ].map(function(r){ return '<div class="row"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>'; }).join('');
    var cfg = [
      ['Prepayment mode', tk.prepay ? 'ON (auto-cutoff)' : 'off'],
      ['Balance remaining', tk.balance !== null ? tk.balance.toFixed(1) + ' units' : '—'],
      ['Last top-up', tk.charged !== null ? tk.charged + ' kWh' : '—'],
      ['Fault', tk.fault ? 'code ' + tk.fault : 'none ✓'],
      ['Breaker no.', tk.breakerNo || '—'],
    ];
    (tk.protections || []).forEach(function(p){ cfg.push([p.label + (p.on ? '' : ' (off)'), p.value + ' ' + p.unit]); });
    el('brk_cfg').innerHTML = cfg.map(function(r){ return '<div class="row"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>'; }).join('') +
      '<div class="sub" style="margin-top:6px">protection thresholds decoded from the breaker — confirm against the Smart Life app</div>';
    el('brk_controls').style.display = d.tuyaControl ? '' : 'none';
  }

  window.__tariff = d.cfg.tariff;
  if (!window.__repInit){ window.__repInit = 1; loadReport(); }

  el('pv1').textContent = Math.round(s.pv1_v) + ' V · ' + fmtW(s.pv1_w);
  el('pv2').textContent = Math.round(s.pv2_v) + ' V · ' + fmtW(s.pv2_w);
  var h = new Date().getHours();
  el('st1').className = 'st ' + (s.pv1_v > 100 || h < 8 || h > 17 ? 'ok' : 'bad');
  el('st2').className = 'st ' + (s.pv2_v > 50  || h < 8 || h > 17 ? 'ok' : 'bad');

  el('sy_bv').textContent = s.batt_v.toFixed(1) + ' V';
  el('sy_ba').textContent = s.charge_a > 0.5 ? '+' + s.charge_a.toFixed(1) + ' A (charging)'
    : s.discharge_a > 0.5 ? '−' + s.discharge_a.toFixed(1) + ' A (discharging)' : '0 A';
  el('sy_gv').textContent = Math.round(s.grid_v) + ' V';
  el('sy_us').textContent = (d.usableWh/1000).toFixed(1) + ' kWh';

  // Evening plan from the learned load profile (650W fallback per unseen hour)
  var need = 0;
  for (var hh = 19; hh <= 23; hh++) need += d.seen[hh] > 0 ? d.profile[hh] : 650;
  el('ev_have').textContent = (d.usableWh/1000).toFixed(1) + ' kWh (above ' + d.cfg.reserveSoc + '% reserve)';
  el('ev_need').textContent = (need/1000).toFixed(1) + ' kWh' +
    (d.seen.slice(19,24).some(function(x){return x>0;}) ? ' (learned)' : ' (estimate — still learning)');
  el('ev_verdict').textContent = d.usableWh >= need
    ? '✅ Battery covers the evening with margin.'
    : '⚠️ Battery lasts ~' + (d.usableWh/(need/5)).toFixed(1) + ' h — grid takes over around ' +
      Math.min(24, Math.round(19 + d.usableWh/(need/5))) + ':00.';

  var box = el('alerts');
  if (!d.alerts.length){ box.innerHTML = '<div class="empty">No alerts since start ✅</div>'; }
  else {
    box.innerHTML = d.alerts.map(function(a){
      return '<div class="alert"><time>' +
        new Date(a.ts).toLocaleString('en-GB', {timeZone: d.cfg.tz}) + '</time>' +
        a.text.replace(/</g, '&lt;') + '</div>';
    }).join('');
  }
}
setInterval(function(){
  cd = Math.max(0, cd - 1);
  var c = document.getElementById('cd');
  if (c) c.textContent = 'refresh in ' + cd + 's';
}, 1000);
load(); setInterval(load, REFRESH * 1000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
</script></body></html>`;

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#0b0f14"/><circle cx="50" cy="44" r="15" fill="#fbbf24"/><g stroke="#fbbf24" stroke-width="5" stroke-linecap="round"><line x1="50" y1="17" x2="50" y2="24"/><line x1="50" y1="64" x2="50" y2="71"/><line x1="23" y1="44" x2="30" y2="44"/><line x1="70" y1="44" x2="77" y2="44"/><line x1="31" y1="25" x2="36" y2="30"/><line x1="64" y1="58" x2="69" y2="63"/><line x1="69" y1="25" x2="64" y2="30"/><line x1="36" y1="58" x2="31" y2="63"/></g><path d="M44 76 L60 76 L48 94 L52 82 L40 82 Z" fill="#38bdf8"/></svg>`;

// ---------- DASHBOARD AUTH ----------
// Cookie survives restarts (token derived from the password, not process state)
const sessionToken = () => CFG.DASH_PASSWORD
  ? createHmac("sha256", CFG.DASH_PASSWORD).update("solar-watchdog-session").digest("hex") : "";
const isAuthed = (req) => !CFG.DASH_PASSWORD ||
  (req.headers.cookie || "").includes("dw_auth=" + sessionToken());

const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Solar Watchdog</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0f14;
color:#e7eef6;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.box{background:#121924;border:1px solid #1e2936;border-radius:16px;padding:28px;
width:min(320px,88vw);text-align:center}
input{width:100%;box-sizing:border-box;background:#0e141c;border:1px solid #1e2936;
border-radius:10px;color:#e7eef6;padding:10px 12px;font-size:15px;margin:16px 0 10px}
button{width:100%;background:#14283c;border:1px solid #24405c;color:#38bdf8;
border-radius:10px;padding:10px;font-size:14px;font-weight:600;cursor:pointer}
.err{color:#f87171;font-size:13px;min-height:18px;margin-top:8px}</style></head><body>
<div class="box"><div style="font-size:30px">☀️</div><b>Solar Watchdog</b>
<input id="pw" type="password" placeholder="password" autofocus>
<button onclick="go()">Unlock</button><div class="err" id="err"></div></div>
<script>
async function go(){
  var r = await fetch('/api/login', { method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ password: document.getElementById('pw').value }) });
  if (r.ok) location.reload();
  else document.getElementById('err').textContent = 'Wrong password';
}
document.getElementById('pw').addEventListener('keydown', function(e){ if (e.key === 'Enter') go(); });
</script></body></html>`;

if (CFG.HTTP_PORT > 0) {
  createServer(async (req, res) => {
    // public routes (no data): PWA assets + login
    if (req.method === "POST" && req.url.startsWith("/api/login")) {
      res.setHeader("Content-Type", "application/json");
      try {
        const { password } = JSON.parse(await readBody(req) || "{}");
        if (CFG.DASH_PASSWORD && password === CFG.DASH_PASSWORD) {
          res.setHeader("Set-Cookie", `dw_auth=${sessionToken()}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
          return res.end(JSON.stringify({ ok: true }));
        }
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: "wrong password" }));
      } catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ error: e.message })); }
    }
    if (req.url.startsWith("/manifest.json") || req.url.startsWith("/sw.js") || req.url.startsWith("/icon.svg")) {
      // fall through to handlers below
    } else if (!isAuthed(req)) {
      if (req.url.startsWith("/api/")) {
        res.statusCode = 401; res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(LOGIN_HTML);
    }
    if (req.method === "POST" && req.url.startsWith("/api/breaker")) {
      res.setHeader("Content-Type", "application/json");
      if (!CFG.TUYA_CONTROL) { res.statusCode = 403; return res.end(JSON.stringify({ error: "breaker control disabled — set TUYA_CONTROL=1 to enable" })); }
      try {
        const { action, value } = JSON.parse(await readBody(req) || "{}");
        let commands, note;
        if (action === "supply") { commands = [{ code: "switch", value: !!value }]; note = `supply ${value ? "ON" : "OFF"}`; }
        else if (action === "prepay") { commands = [{ code: "switch_prepayment", value: !!value }]; note = `prepayment ${value ? "ON" : "OFF"}`; }
        else if (action === "topup") {
          const n = Math.round(Number(value));
          if (!(n > 0 && n <= 1000)) { res.statusCode = 400; return res.end(JSON.stringify({ error: "top-up must be 1–1000 units" })); }
          commands = [{ code: "charge_energy", value: n }]; note = `topped up ${n} units`;
        } else if (action === "protect") {
          const info = computeMeters(); const m = info.meters.find(x => x.active);
          if (!m) { res.statusCode = 400; return res.end(JSON.stringify({ error: "no active meter set" })); }
          const used = m.meas > 0 ? m.meas : m.est;
          const target = Math.max(0, m.budget - used);
          const cur = latest.tuya && latest.tuya.balance != null ? latest.tuya.balance : 0;
          const add = Math.round(target - cur);
          if (add <= 0) return res.end(JSON.stringify({ ok: true, noCommand: true, note: `Balance ${cur.toFixed(1)}u already ≥ target ${target}u for ${m.name}. Reduce it in the Smart Life app if you need it lower.` }));
          commands = [{ code: "charge_energy", value: add }];
          note = `topped up ${add}u → ~${target}u so the breaker cuts at ${m.name}'s ${m.budget}-unit budget (used ${used}u)`;
        } else { res.statusCode = 400; return res.end(JSON.stringify({ error: "unknown action" })); }
        await tuyaCommand(commands);
        latest.tuya = null; // force a fresh read next poll
        await sendAlert(`🔧 BREAKER CONTROL: ${note} (via dashboard)`);
        return res.end(JSON.stringify({ ok: true, note }));
      } catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ error: e.message })); }
    }
    if (req.method === "POST" && req.url.startsWith("/api/meter/active")) {
      res.setHeader("Content-Type", "application/json");
      try {
        const { meter } = JSON.parse(await readBody(req) || "{}");
        const db = loadMeters();
        if (!db.meters.find(x => x.id === meter)) { res.statusCode = 400; return res.end(JSON.stringify({ error: "unknown meter" })); }
        db.activeLog.push({ meter, ts: Date.now() });
        while (db.activeLog.length > 1000) db.activeLog.shift();
        saveJson(CFG.METERS_FILE, db);
        return res.end(JSON.stringify({ ok: true, active: meter }));
      } catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ error: e.message })); }
    }
    if (req.method === "POST" && req.url.startsWith("/api/meter")) {
      return handleMeterPost(req, res);
    }
    if (req.url.startsWith("/manifest.json")) {
      res.setHeader("Content-Type", "application/manifest+json");
      return res.end(JSON.stringify({
        name: "Solar Watchdog", short_name: "Solar",
        start_url: CFG.PUBLIC_URL ? CFG.PUBLIC_URL + "/" : "/",
        scope: CFG.PUBLIC_URL ? CFG.PUBLIC_URL + "/" : "/",
        display: "standalone",
        background_color: "#0b0f14", theme_color: "#0b0f14",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      }));
    }
    if (req.url.startsWith("/sw.js")) {
      res.setHeader("Content-Type", "application/javascript");
      return res.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('fetch',()=>{});");
    }
    if (req.url.startsWith("/icon.svg")) {
      res.setHeader("Content-Type", "image/svg+xml");
      return res.end(ICON_SVG);
    }
    if (req.url.startsWith("/api/report")) {
      const g = new URL(req.url, "http://x").searchParams.get("g") || "day";
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ granularity: g, rows: reportRows(g) }));
    }
    if (req.url.startsWith("/api/status")) {
      try { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(await statusPayload())); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
    } else {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(DASHBOARD_HTML);
    }
  }).listen(CFG.HTTP_PORT, () => console.log(
    `Dashboard: http://localhost:${CFG.HTTP_PORT}${CFG.PUBLIC_URL ? " → " + CFG.PUBLIC_URL : ""}`));
}

console.log(`Solar Watchdog v2 — every ${CFG.POLL_MINUTES} min | site ${CFG.LAT},${CFG.LON} | array ${CFG.KWP_W}W`);
poll();
setInterval(poll, CFG.POLL_MINUTES * 60_000);

// Fast breaker monitor (high-grid alert + pump detection) on its own cadence
if (CFG.TUYA_ID && CFG.TUYA_DEVICE) {
  pumpMonitor();
  setInterval(pumpMonitor, CFG.PUMP_POLL_MIN * 60_000);
}
