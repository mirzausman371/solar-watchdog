#!/usr/bin/env node
// FESCO bill fetcher — runs on a PAKISTANI IP (Mac / home device), because
// bill.pitc.com.pk blocks foreign IPs. Fetches each meter's latest bill and
// pushes the readings to the watchdog server, which updates the meter cards.
//
// Config via env (or edit the defaults below):
//   PUSH_URL   = https://solar.skillmatch.tech/api/fesco/ingest
//   PUSH_TOKEN = <matches server FESCO_PUSH_TOKEN>
// Refs are stable, so they're inlined.

const PUSH_URL = process.env.PUSH_URL || "https://solar.skillmatch.tech/api/fesco/ingest";
const PUSH_TOKEN = process.env.PUSH_TOKEN || "REPLACE_WITH_TOKEN";
const METERS = [
  { meterId: "usman",  ref: "05132140285107" },
  { meterId: "majeed", ref: "05132140285109" },
  { meterId: "razia",  ref: "05132140310650" },
  { meterId: "hamid",  ref: "05132140310600" },
];

const FESCO_BASE = "https://bill.pitc.com.pk/fescobill";
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const field = (html, name) => { const m = html.match(new RegExp('name="' + name + '"[^>]*?value="([^"]*)"')); return m ? m[1] : ""; };

async function fetchBill(ref) {
  const jar = {};
  const grab = (res) => { const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : []; for (const c of sc) { const kv = c.split(";")[0], i = kv.indexOf("="); if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1); } };
  let res = await fetch(FESCO_BASE, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25000) });
  let html = await res.text(); grab(res);
  const form = {
    __EVENTTARGET: "", __EVENTARGUMENT: "", __LASTFOCUS: "",
    __VIEWSTATE: field(html, "__VIEWSTATE"), __VIEWSTATEGENERATOR: field(html, "__VIEWSTATEGENERATOR"),
    __EVENTVALIDATION: field(html, "__EVENTVALIDATION"), __RequestVerificationToken: field(html, "__RequestVerificationToken"),
    rbSearchByList: "refno", searchTextBox: ref, ruCodeTextBox: "", btnSearch: "Search",
  };
  const body = Object.entries(form).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  res = await fetch(FESCO_BASE, { method: "POST", redirect: "follow", signal: AbortSignal.timeout(25000),
    headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded", "Referer": FESCO_BASE,
      Cookie: Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ") }, body });
  html = await res.text();
  if (!html.includes(ref)) return null;
  const txt = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const pr = txt.match(/PRESENT READING[^\d]*(\d+)\s*UNITS[^\d]*(\d+)/i);
  const mo = txt.match(/BILL MONTH[^A-Za-z]*([A-Za-z]{3})\s*(\d{2})/i);
  if (!pr || !mo || !MON[mo[1].toUpperCase()]) return null;
  return { present: Number(pr[1]), units: Number(pr[2]), month: `20${mo[2]}-${MON[mo[1].toUpperCase()]}` };
}

const bills = [];
for (const m of METERS) {
  try {
    const b = await fetchBill(m.ref);
    if (b) { bills.push({ meterId: m.meterId, ...b }); console.log(`${m.meterId}: ${b.present} (${b.units}u, ${b.month})`); }
    else console.error(`${m.meterId}: no bill parsed`);
  } catch (e) { console.error(`${m.meterId}: ${e.message}`); }
}
if (!bills.length) { console.error("no bills fetched — aborting push"); process.exit(1); }

const res = await fetch(PUSH_URL, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: PUSH_TOKEN, bills }), signal: AbortSignal.timeout(20000),
});
const out = await res.json();
console.log("push result:", JSON.stringify(out));
process.exit(res.ok && !out.error ? 0 : 1);
