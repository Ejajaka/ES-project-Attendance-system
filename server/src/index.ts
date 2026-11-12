import { Hono } from "hono";
import {
  parseDeviceReport,
  evaluateInstances,
  roomCountError,
  buildAttendance,
  attendanceToCsv,
  RosterSchema,
  ROOM_TTL_MS,
  ROOM_BLE_RSSI_THRESHOLD,
  ROOM_WIFI_RSSI_THRESHOLD,
  ROOM_ENTER_MS,
  ROOM_EXIT_MS,
  suggestThresholds,
  adaptiveThreshold,
  roomPresence,
  type AttendanceSheet,
  type GroundTruth,
  type DeviceReport,
} from "shared";
import { computeDevicePresence, type SessionConfig } from "./presence";
import { MemoryStore, type Store, type SignalBaseline } from "./store";
import { SessionRegistry, type CreateSessionInput } from "./sessions";
import { buildSeries } from "./series";
import { dashboardHtml } from "./dashboard";
import type { E2eEvent } from "./store";

/**
 * Shusseki fusion server. Ingests Soshin/Jushin reports, computes per-modality
 * + fused presence, and evaluates against manual ground truth. Deployable on
 * Node (`tsx src/server.ts`) or Cloudflare Workers (Hono is runtime-agnostic).
 */

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;",
  );
}

/**
 * Live attendance register (dependency-free HTML). The roster is entered inline
 * (one `roll,name` per line) and POSTed to `/api/sessions/:id/roster`; the sheet
 * auto-refreshes every 5 s. Open in any browser on the room's network.
 */
function attendanceHtml(sheet: AttendanceSheet, paused = false): string {
  const rows = sheet.rows
    .map(
      (r) =>
        `<tr class="${r.present ? "p" : "a"}"><td>${esc(r.name)}</td><td>${esc(
          r.studentId,
        )}</td><td>${r.present ? "PRESENT" : "absent"}</td></tr>`,
    )
    .join("");
  const unrostered = sheet.unrostered
    .map(
      (u) =>
        `<li>${esc(u.deviceId)}${u.studentId ? ` (${esc(u.studentId)})` : ""} — ${
          u.present ? "present" : "absent"
        }</li>`,
    )
    .join("");
  const sid = encodeURIComponent(sheet.sessionId);

  const script = [
    "var ROSTER_URL = location.pathname.replace('/attendance/','/api/sessions/') + '/roster';",
    "function loadRoster(){ fetch(ROSTER_URL).then(function(r){return r.json();}).then(function(j){",
    "  document.getElementById('roster').value = (j.students||[]).map(function(s){return [s.studentId,s.name,s.deviceId||'',s.rfidUid||''].join(',').replace(/,+$/,'');}).join(String.fromCharCode(10));",
    "}).catch(function(){}); }",
    "loadRoster();",
    "function saveRoster(e){ e.preventDefault();",
    "  var lines = document.getElementById('roster').value.split(String.fromCharCode(10));",
    "  var students = lines.map(function(l){return l.trim();}).filter(Boolean).map(function(l){",
  "    var p = l.split(','); var studentId=(p[0]||'').trim(); var name=(p[1]||'').trim(); var deviceId=(p[2]||'').trim(); var rfidUid=(p[3]||'').trim().toUpperCase();",
  "    var s = { studentId: studentId, name: name }; if (deviceId) { s.deviceId = deviceId; } if (rfidUid) { s.rfidUid = rfidUid; } return s; });",
    "  fetch(ROSTER_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({students:students})})",
    "    .then(function(){ location.reload(); });",
    "  return false; }",
    `function clearAttendance(e){ e.preventDefault(); if(!confirm('Clear ALL attendance AND the roster for this session?')) return false; fetch('/api/sessions/${sid}/attendance/reset',{method:'POST'}).then(function(r){return r.json();}).then(function(d){ if(d.error){ alert(d.error); } location.reload(); }).catch(function(err){ alert('Failed: '+err); }); return false; }`,
    `function resume(e){ e.preventDefault(); fetch('/api/sessions/${sid}/resume',{method:'POST'}).then(function(){ location.reload(); }); return false; }`,
  ].join("\n");

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Shusseki attendance · ${esc(sheet.sessionId)}</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, Menlo, Consolas, monospace; background:#0b0e0c; color:#c8f7d4; margin:0; padding:24px; }
  h1 { font-size:18px; letter-spacing:.14em; text-transform:uppercase; }
  .meta { color:#6b8f78; margin:6px 0 18px; }
  table { border-collapse:collapse; width:100%; max-width:780px; }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid #1d2a22; }
  th { color:#7fe3a1; text-transform:uppercase; font-size:11px; letter-spacing:.1em; }
  tr.p td:nth-child(3){ color:#6dff9e; font-weight:700; }
  tr.a { color:#5f6f66; }
  textarea { width:100%; max-width:780px; height:120px; background:#0f1512; color:#c8f7d4; border:1px solid #24382c; padding:8px; font:inherit; }
  button { background:#19d36b; color:#04120a; border:0; padding:8px 14px; font:inherit; font-weight:700; cursor:pointer; letter-spacing:.08em; }
  button.danger { background:#ff3b5c; color:#12040a; }
  .paused { border:1px solid #ffb000; color:#ffb000; padding:10px; margin:12px 0; max-width:780px; }
  a { color:#7fe3a1; }
  ul { color:#8aa196; }
</style></head><body>
<h1>出席 · Shusseki attendance</h1>
<div class="meta">session <b>${esc(sheet.sessionId)}</b> · present <b>${sheet.presentCount}</b> / ${
    sheet.rosterCount
  } · updated ${new Date(sheet.generatedAt).toLocaleTimeString()} · <a href="/api/sessions/${sid}/attendance?format=csv">download CSV</a> · <a href="/calibrate/${sid}">calibrate</a> · <a href="/dashboard/${sid}">dashboard</a></div>
${
  paused
    ? `<div class="paused">PAUSED — attendance and roster cleared; new reports are ignored.
         <form onsubmit="return resume(event)" style="display:inline;margin-left:12px">
           <button type="submit">RESUME</button>
         </form></div>`
    : ""
}
<table>
<thead><tr><th>Name</th><th>Roll no</th><th>Present</th></tr></thead>
<tbody>${rows || '<tr><td colspan="3">No roster yet — add students below.</td></tr>'}</tbody>
</table>
${unrostered ? `<h3>Unrostered devices seen</h3><ul>${unrostered}</ul>` : ""}
<form onsubmit="return saveRoster(event)">
  <p>Roster — one <code>roll,name[,deviceId[,rfidUid]]</code> per line:</p>
  <textarea id="roster"></textarea>
  <p><button type="submit">SAVE ROSTER</button></p>
</form>
<form onsubmit="return clearAttendance(event)" style="margin-top:10px">
  <button class="danger" type="submit">CLEAR ATTENDANCE</button>
</form><script>
${script}
</script>
</body></html>`;
}

/**
 * Room-boundary calibration page. Walk the phone to each spot and tap
 * MARK INSIDE / MARK OUTSIDE; the server suggests BLE/WiFi thresholds and can
 * apply them to the session. No dependency outside the browser.
 */
function calibrationHtml(sessionId: string): string {
  const sid = encodeURIComponent(sessionId);
  const script = [
    `var BASE = '/api/sessions/${sid}';`,
    "function esc(s){ return String(s).replace(/[&<>\\\"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','\\\"':'&quot;'})[c]; }); }",
    "function fmt(v){ return v==null ? '—' : v+' dBm'; }",
    "function refresh(){",
    "  fetch(BASE + '/calibrate').then(function(r){return r.json();}).then(function(d){",
    "    document.getElementById('cur').innerHTML = 'room node: <b>' + esc(d.current.roomNodeId || '(not announced)') + '</b><br>' + 'BLE threshold: <b>' + d.current.bleRssiThreshold + ' dBm</b> · WiFi threshold: <b>' + d.current.wifiRssiThreshold + ' dBm</b>';",
    "    var l = (d.latest||[]).map(function(x){ return '<li>' + esc(x.deviceId) + ' → BLE ' + fmt(x.ble) + ' · WiFi ' + fmt(x.wifi) + ' · ' + (x.inRoom ? '<b class=\"in\">IN ROOM</b>' : 'outside') + '</li>'; }).join('');",
    "    document.getElementById('latest').innerHTML = l || '<li>no reports yet — open the receiver app and ENGAGE</li>';",
    "    var s = d.suggestion;",
    "    document.getElementById('sugg').innerHTML = 'inside samples: <b>' + s.insideSamples + '</b> · outside: <b>' + s.outsideSamples + '</b><br>' + 'suggested BLE: <b>' + (s.bleRssiThreshold==null?'—':s.bleRssiThreshold) + ' dBm</b>' + (s.bleOverlap ? ' <span class=\"warn\">(overlap)</span>' : '') + '<br>' + 'suggested WiFi: <b>' + (s.wifiRssiThreshold==null?'—':s.wifiRssiThreshold) + ' dBm</b>' + (s.wifiOverlap ? ' <span class=\"warn\">(overlap)</span>' : '');",
    "    var c = d.samples||[]; var ins=c.filter(function(x){return x.label==='inside';}); var outs=c.filter(function(x){return x.label==='outside';});",
    "    function row(arr){ if(!arr.length) return '—'; return arr.slice(-8).map(function(x){ return 'B' + (x.ble==null?'—':x.ble) + '/W' + (x.wifi==null?'—':x.wifi); }).join('   '); }",
    "    document.getElementById('samp').innerHTML = '<div><b>INSIDE</b> &nbsp; ' + row(ins) + '</div><div><b>OUTSIDE</b> &nbsp; ' + row(outs) + '</div>';",
    "  }).catch(function(){});",
    "}",
    "function mark(label){",
    "  fetch(BASE + '/calibrate', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({label:label})})",
    "    .then(function(r){return r.json();}).then(function(d){ if(d.error){ alert(d.error); } refresh(); });",
    "}",
    "function apply(){",
    "  fetch(BASE + '/calibrate/apply', {method:'POST', headers:{'content-type':'application/json'}, body:'{}'})",
    "    .then(function(r){return r.json();}).then(function(d){ if(d.error){ alert(d.error); } else { alert('Applied BLE ' + (d.applied.bleRssiThreshold==null?'—':d.applied.bleRssiThreshold) + ' dBm / WiFi ' + (d.applied.wifiRssiThreshold==null?'—':d.applied.wifiRssiThreshold) + ' dBm'); } refresh(); });",
    "}",
    "refresh(); setInterval(refresh, 3000);",
  ].join("\n");

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shusseki calibration · ${esc(sessionId)}</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, Menlo, Consolas, monospace; background:#0b0e0c; color:#c8f7d4; margin:0; padding:24px; }
  h1 { font-size:18px; letter-spacing:.14em; text-transform:uppercase; }
  .box { border:1px solid #1d2a22; padding:12px; margin:12px 0; max-width:820px; }
  .meta { color:#6b8f78; }
  ul { margin:6px 0; padding-left:18px; color:#9fb8a8; }
  .in { color:#6dff9e; }
  .warn { color:#ffcf5c; }
  button { background:#19d36b; color:#04120a; border:0; padding:10px 16px; font:inherit; font-weight:700; cursor:pointer; letter-spacing:.06em; margin-right:8px; }
  button.alt { background:#ffcf5c; }
  a { color:#7fe3a1; }
</style></head><body>
<h1>出席 · Calibrate room boundary</h1>
<div class="meta">session <b>${esc(sessionId)}</b> · <a href="/attendance/${sid}">back to register</a></div>

<div class="box"><div id="cur">loading…</div></div>
<div class="box"><b>LATEST READING</b><ul id="latest"></ul></div>
<div class="box"><b>SUGGESTED THRESHOLDS</b><div id="sugg"></div></div>
<div class="box"><b>SAMPLES</b><div id="samp"></div></div>
<div class="box">
  <p>Put the phone <b>inside the room</b> and tap MARK INSIDE (2–3 times, move around).<br>
  Then step into the <b>corridor</b> and tap MARK OUTSIDE.</p>
  <button onclick="mark('inside')">MARK INSIDE</button>
  <button class="alt" onclick="mark('outside')">MARK OUTSIDE</button>
  <button onclick="apply()">APPLY SUGGESTED</button>
</div>
<script>
${script}
</script>
</body></html>`;
}

export function createApp(store: Store, sessions: SessionRegistry): Hono {
  const app = new Hono();

  /**
   * Threshold-only gate: use the calibrated session boundaries directly.
   * (The old adaptive per-device loosening is removed — the calibration rule
   * already places the boundary just above the strongest outside reading.)
   */
  const effectiveOptions = (config: SessionConfig, _baseline?: SignalBaseline) => ({
    bleRssiThreshold: config.bleRssiThreshold ?? ROOM_BLE_RSSI_THRESHOLD,
    wifiRssiThreshold: config.wifiRssiThreshold ?? ROOM_WIFI_RSSI_THRESHOLD,
  });

  app.get("/", (c) =>
    c.json({
      ok: true,
      name: "Shusseki fusion server",
      version: "0.1.0",
      docs: "GET /health, POST /api/sessions, POST /api/reports, GET /api/sessions/:id/presence, POST /api/sessions/:id/ground-truth, GET /api/sessions/:id/evaluate",
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/api/e2e", async (c) => {
    let event: E2eEvent;
    try {
      event = (await c.req.json()) as E2eEvent;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!event?.sessionId || !event?.deviceId || !event?.role || !event?.phase) {
      return c.json(
        { error: "sessionId, deviceId, role and phase are required" },
        400,
      );
    }
    store.e2eUpsert({ ...event, at: event.at ?? Date.now() });
    return c.json({ ok: true }, 201);
  });

  app.get("/api/e2e/:id", (c) => {
    return c.json({ sessionId: c.req.param("id"), events: store.e2eForSession(c.req.param("id")) });
  });

  app.post("/api/sessions", async (c) => {
    let body: CreateSessionInput;
    try {
      body = (await c.req.json()) as CreateSessionInput;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!body?.sessionId || !body?.roomId || !body?.secret) {
      return c.json({ error: "sessionId, roomId and secret are required" }, 400);
    }
    const config = sessions.create(body);
    return c.json({ ok: true, sessionId: config.sessionId }, 201);
  });

  app.post("/api/reports", async (c) => {
    let report: DeviceReport;
    try {
      report = parseDeviceReport(await c.req.json());
    } catch {
      return c.json({ error: "invalid report" }, 400);
    }
    const config = sessions.get(report.sessionId);
    if (!config) return c.json({ error: "unknown session" }, 404);

    // Clearing attendance pauses the session: ignore new reports until resumed,
    // except the calibration probe (it must still be able to measure).
    if (config.paused && !report.deviceId.startsWith("calibrate-")) {
      return c.json({ paused: true, presence: null });
    }

    // Measure the raw room signal first, then learn this phone's baseline.
    const raw = roomPresence(report, { roomNodeId: config.roomNodeId });
    const baseline = store.updateBaseline(report.sessionId, report.deviceId, {
      ble: raw.ble.rssi,
      wifi: raw.wifi.rssi,
    });

    const presence = computeDevicePresence(report, config, effectiveOptions(config, baseline));
    // Fold the raw in-room verdict into the device's dwell state.
    const dwell = store.updateRoomPresence(
      report.sessionId,
      report.deviceId,
      presence.inRoom,
      report.timestamp,
      { enterMs: config.enterMs, exitMs: config.exitMs },
    );
    store.addReport(report);
    // A phone identifying itself auto-enrolls into the roster (name + roll).
    if (report.studentId) {
      store.ensureStudent(report.sessionId, {
        studentId: report.studentId,
        name: report.studentName?.trim() || undefined,
        deviceId: report.deviceId,
        rfidUid: report.rfidUid?.trim().toUpperCase() || undefined,
      });
    }
    // Biometric is the attendance gate: a failed check is not present even if
    // the phone is in the room. (No biometric reported = legacy/headless.)
    const bioOk = report.biometric == null ? true : report.biometric.success;
    const credit = dwell.inRoom && bioOk;
    // Fold this sample into the device's attendance timeline (dwelled verdict).
    store.recordSample(
      report.sessionId,
      report.deviceId,
      report.studentId,
      report.timestamp,
      credit,
    );
    return c.json({ presence: { ...presence, present: credit, bioOk, dwell } });
  });

  app.get("/api/sessions/:id/presence", (c) => {
    const id = c.req.param("id");
    const config = sessions.get(id);
    if (!config) return c.json({ error: "unknown session" }, 404);
    const latest = store.latestPerDevice(id);
    const now = Date.now();
    const ttl = config.ttlMs ?? ROOM_TTL_MS;
    const devices = [...latest.values()].map((r) => {
      const p = computeDevicePresence(
        r,
        config,
        effectiveOptions(config, store.getBaseline(id, r.deviceId)),
      );
      const dwell = store.getDwell(id, r.deviceId);
      const ageMs = now - r.timestamp;
      const fresh = ageMs <= ttl;
      const bioOk = r.biometric == null ? true : r.biometric.success;
      const inRoom = fresh && bioOk ? (dwell?.inRoom ?? p.inRoom) : false;
      return { ...p, present: inRoom, inRoom, bioOk, ageMs, dwell: dwell ?? null };
    });
    return c.json({ sessionId: id, devices });
  });

  // Live series for the dashboard: BLE/WiFi RSSI + ultrasonic SNR per device.
  app.get("/api/sessions/:id/series", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    c.header("cache-control", "no-store");
    return c.json(
      buildSeries(id, store.reportsForSession(id), {
        telemetry: store.telemetryForSession(id),
      }),
    );
  });

  // Fast graph samples (BLE/WiFi at 0.5 s) — no presence computation.
  app.post("/api/sessions/:id/telemetry", async (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    let body: {
      deviceId?: string;
      t?: number;
      ble?: number | null;
      wifi?: number | null;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!body?.deviceId) return c.json({ error: "deviceId is required" }, 400);
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    store.addTelemetry(id, {
      deviceId: body.deviceId,
      t: num(body.t) ?? Date.now(),
      ble: num(body.ble),
      wifi: num(body.wifi),
    });
    return c.json({ ok: true }, 202);
  });

  // A transmitter announces its (system-assigned) hotspot SSID/passphrase so
  // receivers that picked the same preset room can auto-join it.
  app.post("/api/sessions/:id/hotspot", async (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    let body: { deviceId?: string; ssid?: string; passphrase?: string | null };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!body?.deviceId || !body?.ssid) {
      return c.json({ error: "deviceId and ssid are required" }, 400);
    }
    store.setHotspot({
      sessionId: id,
      deviceId: body.deviceId,
      ssid: body.ssid,
      passphrase: body.passphrase ?? null,
      at: Date.now(),
    });
    // The announcing transmitter owns this room's BLE node id.
    sessions.setRoomNode(id, body.deviceId);
    return c.json({ ok: true }, 201);
  });

  app.get("/api/sessions/:id/hotspot", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    return c.json({ hotspot: store.getHotspot(id) ?? null });
  });

  // --- Attendance -----------------------------------------------------------

  app.post("/api/sessions/:id/roster", async (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const parsed = RosterSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid roster" }, 400);
    store.setRoster(id, parsed.data.students);
    return c.json({ ok: true, count: parsed.data.students.length }, 201);
  });

  app.get("/api/sessions/:id/roster", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    return c.json({ sessionId: id, students: store.rosterForSession(id) });
  });

  const attendanceSheet = (id: string): AttendanceSheet =>
    buildAttendance({
      sessionId: id,
      generatedAt: Date.now(),
      students: store.rosterForSession(id),
      // Calibration probes are not students — keep them out of the register.
      timelines: store
        .timelinesForSession(id)
        .filter((t) => !t.deviceId.startsWith("calibrate-")),
      marks: store.marksForSession(id),
      ttlMs: sessions.get(id)?.ttlMs ?? ROOM_TTL_MS,
    });

  app.get("/api/sessions/:id/attendance", (c) => {
    const id = c.req.param("id");
    const config = sessions.get(id);
    if (!config) return c.json({ error: "unknown session" }, 404);
    const sheet = attendanceSheet(id);
    const format = c.req.query("format");
    if (format === "csv") {
      return c.body(attendanceToCsv(sheet), 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="attendance-${id}.csv"`,
      });
    }
    if (format === "html") {
      c.header("cache-control", "no-store");
      return c.html(attendanceHtml(sheet, config.paused === true));
    }
    return c.json(sheet);
  });

  // Human-friendly live register: open in a browser on any device.
  app.get("/attendance/:id", (c) => {
    const id = c.req.param("id");
    const config = sessions.get(id);
    if (!config) return c.json({ error: "unknown session" }, 404);
    c.header("cache-control", "no-store");
    return c.html(attendanceHtml(attendanceSheet(id), config.paused === true));
  });

  // Live browser dashboard: BLE/WiFi RSSI + ultrasonic SNR charts.
  app.get("/dashboard/:id", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    c.header("cache-control", "no-store");
    return c.html(dashboardHtml(id));
  });

  // --- Room-boundary calibration -------------------------------------------

  const calibrationPayload = (id: string) => {
    const config = sessions.get(id)!;
    const samples = store.calibrationForSession(id);
    const suggestion = suggestThresholds(
      samples.map((s) => ({ label: s.label, ble: s.ble, wifi: s.wifi })),
    );
    const latest = [...store.latestPerDevice(id).values()].map((r) => {
      const baseline = store.getBaseline(id, r.deviceId);
      const eff = effectiveOptions(config, baseline);
      const p = computeDevicePresence(r, config, eff);
      const dwell = store.getDwell(id, r.deviceId);
      const fresh = Date.now() - r.timestamp <= (config.ttlMs ?? ROOM_TTL_MS);
      return {
        deviceId: r.deviceId,
        at: r.timestamp,
        ble: p.room.ble.rssi,
        wifi: p.room.wifi.rssi,
        // Report the debounced verdict so a single missed scan doesn't flap.
        inRoom: fresh ? (dwell?.inRoom ?? p.room.inRoom) : false,
        baseline: baseline ?? null,
        effective: eff,
      };
    });
    return {
      sessionId: id,
      current: {
        roomNodeId: config.roomNodeId ?? null,
        bleRssiThreshold: config.bleRssiThreshold ?? ROOM_BLE_RSSI_THRESHOLD,
        wifiRssiThreshold: config.wifiRssiThreshold ?? ROOM_WIFI_RSSI_THRESHOLD,
        ttlMs: config.ttlMs ?? ROOM_TTL_MS,
        enterMs: config.enterMs ?? ROOM_ENTER_MS,
        exitMs: config.exitMs ?? ROOM_EXIT_MS,
      },
      suggestion,
      samples,
      latest,
    };
  };

  // Record the current RSSI of the reporting phone(s) under a label.
  app.post("/api/sessions/:id/calibrate", async (c) => {
    const id = c.req.param("id");
    const config = sessions.get(id);
    if (!config) return c.json({ error: "unknown session" }, 404);
    let body: { label?: "inside" | "outside"; deviceId?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (body?.label !== "inside" && body?.label !== "outside") {
      return c.json({ error: "label must be 'inside' or 'outside'" }, 400);
    }
    const latest = store.latestPerDevice(id);
    const targets = body.deviceId
      ? [latest.get(body.deviceId)].filter((r): r is NonNullable<typeof r> => r != null)
      : [...latest.values()];
    if (targets.length === 0) {
      return c.json({ error: "no recent report from a device" }, 409);
    }
    let added = 0;
    for (const r of targets) {
      const p = computeDevicePresence(r, config);
      const ble = p.room.ble.rssi;
      const wifi = p.room.wifi.rssi;
      // Skip ticks where the phone saw nothing — a missed BLE scan must not
      // become a bogus "weak signal" calibration sample.
      if (ble == null && wifi == null) continue;
      store.addCalibration({
        sessionId: id,
        label: body.label,
        deviceId: r.deviceId,
        ble,
        wifi,
        at: Date.now(),
      });
      added++;
    }
    if (added === 0) {
      return c.json(
        { error: "no signal in the last report — wait a couple of seconds and tap again" },
        409,
      );
    }
    return c.json({ ok: true, added }, 201);
  });

  app.get("/api/sessions/:id/calibrate", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    return c.json(calibrationPayload(id));
  });

  // Start a clean calibration (drop this session's samples).
  app.post("/api/sessions/:id/calibrate/reset", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    store.clearCalibration(id);
    return c.json({ ok: true });
  });

  // RFID / offline card tap. The ESP32 queues these on its microSD when WiFi
  // is unavailable and replays them here when it reconnects. A mark is
  // intentionally non-expiring: it is only cleared by an attendance reset.
  app.post("/api/sessions/:id/rfid", async (c) => {
    const id = c.req.param("id");
    const config = sessions.get(id);
    if (!config) return c.json({ error: "unknown session" }, 404);
    if (config.paused) return c.json({ paused: true }, 409);
    let body: {
      uid?: string;
      studentId?: string;
      studentName?: string;
      at?: number;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const uid =
      typeof body.uid === "string" ? body.uid.trim().toUpperCase() : "";
    if (!uid) {
      return c.json({ error: "uid is required" }, 400);
    }
    // The phone-entered UID mapping is authoritative: look it up first, but
    // ignore auto-created placeholder rows (RFID-… / Card …) — a real binding
    // must be able to replace them.
    const isPlaceholder = (s: { studentId: string; name: string }) =>
      s.studentId.toUpperCase().startsWith("RFID-") ||
      s.name.toUpperCase().startsWith("CARD ");
    const byUid = store
      .rosterForSession(id)
      .find(
        (s) =>
          (s.rfidUid ?? "").trim().toUpperCase() === uid &&
          !isPlaceholder(s),
      );
    const bodyStudentId =
      typeof body.studentId === "string" && body.studentId.trim()
        ? body.studentId.trim()
        : "";
    const bodyName =
      typeof body.studentName === "string" && body.studentName.trim()
        ? body.studentName.trim()
        : undefined;
    const studentId =
      byUid?.studentId || bodyStudentId || `RFID-${uid}`;
    const name = byUid?.name || bodyName;
    const at =
      typeof body.at === "number" && Number.isFinite(body.at)
        ? body.at
        : Date.now();
    const bindUid =
      !!byUid ||
      (!!bodyStudentId && !bodyStudentId.toUpperCase().startsWith("RFID-"));
    store.ensureStudent(id, {
      studentId,
      name,
      rfidUid: bindUid ? uid : undefined,
    });
    store.markPresent(id, { studentId, at, uid, name });
    return c.json(
      {
        ok: true,
        studentId,
        name: name ?? studentId,
        at,
        source: byUid ? "roster" : bodyStudentId ? "body" : "rfid",
      },
      201,
    );
  });

  // Enrollment-time UID binding: the phone sends roll/name/UID immediately, so
  // RFID taps work even when the receiver is not running.
  app.post("/api/sessions/:id/rfid/bind", async (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    let body: { uid?: string; studentId?: string; studentName?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const uid =
      typeof body.uid === "string" ? body.uid.trim().toUpperCase() : "";
    const studentId =
      typeof body.studentId === "string" ? body.studentId.trim() : "";
    if (!uid || !studentId) {
      return c.json({ error: "uid and studentId are required" }, 400);
    }
    const name =
      typeof body.studentName === "string" && body.studentName.trim()
        ? body.studentName.trim()
        : undefined;
    store.ensureStudent(id, { studentId, name, rfidUid: uid });
    return c.json(
      { ok: true, uid, studentId, name: name ?? studentId },
      201,
    );
  });

  // Clear the attendance register AND the roster (drops reports, timelines,
  // roster). The session is PAUSED so still-running phones cannot re-fill it;
  // RESUME lets phones auto-enroll again.
  app.post("/api/sessions/:id/attendance/reset", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    store.clearAttendance(id);
    store.setRoster(id, []);
    sessions.setPaused(id, true);
    return c.json({ ok: true, paused: true });
  });

  // Resume ingestion after a clear.
  app.post("/api/sessions/:id/resume", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    sessions.setPaused(id, false);
    return c.json({ ok: true, paused: false });
  });

  // Apply the suggested (or explicitly supplied) thresholds to the session.
  app.post("/api/sessions/:id/calibrate/apply", async (c) => {
    const id = c.req.param("id");
    const config = sessions.get(id);
    if (!config) return c.json({ error: "unknown session" }, 404);
    let body: { bleRssiThreshold?: number; wifiRssiThreshold?: number } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // empty body is fine — use the suggestion
    }
    const suggestion = calibrationPayload(id).suggestion;
    const ble = body.bleRssiThreshold ?? suggestion.bleRssiThreshold;
    const wifi = body.wifiRssiThreshold ?? suggestion.wifiRssiThreshold;
    if (ble == null && wifi == null) {
      return c.json({ error: "no calibration samples to derive thresholds" }, 409);
    }
    sessions.setThresholds(id, {
      bleRssiThreshold: ble ?? undefined,
      wifiRssiThreshold: wifi ?? undefined,
    });
    return c.json({ ok: true, applied: { bleRssiThreshold: ble, wifiRssiThreshold: wifi } });
  });

  app.get("/calibrate/:id", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    c.header("cache-control", "no-store");
    return c.html(calibrationHtml(id));
  });

  app.post("/api/sessions/:id/ground-truth", async (c) => {
    const id = c.req.param("id");
    let body: Omit<GroundTruth, "sessionId">;
    try {
      body = (await c.req.json()) as Omit<GroundTruth, "sessionId">;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const gt: GroundTruth = { ...body, sessionId: id };
    store.addGroundTruth(gt);
    return c.json({ ok: true }, 201);
  });

  app.get("/api/sessions/:id/evaluate", (c) => {
    const id = c.req.param("id");
    const config = sessions.get(id);
    if (!config) return c.json({ error: "unknown session" }, 404);

    const latest = store.latestPerDevice(id);
    const devices = [...latest.values()].map((r) =>
      computeDevicePresence(
        r,
        config,
        effectiveOptions(config, store.getBaseline(id, r.deviceId)),
      ),
    );
    const predictedPresent = devices.filter((d) => d.present).length;

    const gts = store.groundTruthForSession(id);
    const gt = gts[gts.length - 1];
    const headcount = gt?.headcount ?? null;
    const countError =
      headcount == null ? null : roomCountError(predictedPresent, headcount);

    let perInstance = null;
    if (gt?.presentDeviceIds && gt.presentDeviceIds.length > 0) {
      const actual = new Set(gt.presentDeviceIds);
      const samples = devices.map((d) => ({
        confidences: d.confidences,
        actualPresent: actual.has(d.deviceId),
      }));
      perInstance = evaluateInstances(samples, { threshold: config.threshold });
    }

    return c.json({
      sessionId: id,
      predictedPresent,
      headcount,
      countError,
      perInstance,
      devices,
    });
  });

  return app;
}

export const store = new MemoryStore();
export const sessions = new SessionRegistry();
export const app = createApp(store, sessions);
