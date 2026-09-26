import { Hono } from "hono";
import {
  parseDeviceReport,
  evaluateInstances,
  roomCountError,
  buildAttendance,
  attendanceToCsv,
  RosterSchema,
  type AttendanceSheet,
  type GroundTruth,
  type DeviceReport,
} from "shared";
import { computeDevicePresence } from "./presence";
import { MemoryStore, type Store } from "./store";
import { SessionRegistry, type CreateSessionInput } from "./sessions";
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
function attendanceHtml(sheet: AttendanceSheet): string {
  const rows = sheet.rows
    .map((r) => {
      const dur = r.presentMs >= 1000 ? `${Math.round(r.presentMs / 1000)}s` : "—";
      return `<tr class="${r.present ? "p" : "a"}"><td>${esc(r.studentId)}</td><td>${esc(
        r.name,
      )}</td><td>${r.present ? "PRESENT" : "absent"}</td><td>${
        r.deviceId ? esc(r.deviceId) : "—"
      }</td><td>${dur}</td><td>${Math.round(r.coverage * 100)}%</td></tr>`;
    })
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
    "  document.getElementById('roster').value = (j.students||[]).map(function(s){return s.studentId+','+s.name+(s.deviceId?','+s.deviceId:'');}).join(String.fromCharCode(10));",
    "}).catch(function(){}); }",
    "loadRoster();",
    "function saveRoster(e){ e.preventDefault();",
    "  var lines = document.getElementById('roster').value.split(String.fromCharCode(10));",
    "  var students = lines.map(function(l){return l.trim();}).filter(Boolean).map(function(l){",
    "    var p = l.split(','); var studentId=(p[0]||'').trim(); var name=(p[1]||'').trim(); var deviceId=(p[2]||'').trim();",
    "    var s = { studentId: studentId, name: name }; if (deviceId) { s.deviceId = deviceId; } return s; });",
    "  fetch(ROSTER_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({students:students})})",
    "    .then(function(){ location.reload(); });",
    "  return false; }",
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
  a { color:#7fe3a1; }
  ul { color:#8aa196; }
</style></head><body>
<h1>出席 · Shusseki attendance</h1>
<div class="meta">session <b>${esc(sheet.sessionId)}</b> · present <b>${sheet.presentCount}</b> / ${
    sheet.rosterCount
  } · updated ${new Date(sheet.generatedAt).toLocaleTimeString()} · <a href="/api/sessions/${sid}/attendance?format=csv">download CSV</a></div>
<table>
<thead><tr><th>Roll</th><th>Name</th><th>Status</th><th>Device</th><th>Duration</th><th>Coverage</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No roster yet — add students below.</td></tr>'}</tbody>
</table>
${unrostered ? `<h3>Unrostered devices seen</h3><ul>${unrostered}</ul>` : ""}
<form onsubmit="return saveRoster(event)">
  <p>Roster — one <code>roll,name</code> per line:</p>
  <textarea id="roster"></textarea>
  <p><button type="submit">SAVE ROSTER</button></p>
</form>
<script>
${script}
</script>
</body></html>`;
}

export function createApp(store: Store, sessions: SessionRegistry): Hono {
  const app = new Hono();

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

    const presence = computeDevicePresence(report, config);
    store.addReport(report);
    // A phone identifying itself auto-enrolls into the roster (name + roll).
    if (report.studentId) {
      store.ensureStudent(report.sessionId, {
        studentId: report.studentId,
        name: report.studentName?.trim() || undefined,
      });
    }
    // Fold this sample into the device's attendance timeline.
    store.recordSample(
      report.sessionId,
      report.deviceId,
      report.studentId,
      report.timestamp,
      presence.present,
    );
    return c.json({ presence });
  });

  app.get("/api/sessions/:id/presence", (c) => {
    const id = c.req.param("id");
    const config = sessions.get(id);
    if (!config) return c.json({ error: "unknown session" }, 404);
    const latest = store.latestPerDevice(id);
    const devices = [...latest.values()].map((r) =>
      computeDevicePresence(r, config),
    );
    return c.json({ sessionId: id, devices });
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
      timelines: store.timelinesForSession(id),
    });

  app.get("/api/sessions/:id/attendance", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    const sheet = attendanceSheet(id);
    const format = c.req.query("format");
    if (format === "csv") {
      return c.body(attendanceToCsv(sheet), 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="attendance-${id}.csv"`,
      });
    }
    if (format === "html") return c.html(attendanceHtml(sheet));
    return c.json(sheet);
  });

  // Human-friendly live register: open in a browser on any device.
  app.get("/attendance/:id", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "unknown session" }, 404);
    return c.html(attendanceHtml(attendanceSheet(id)));
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
      computeDevicePresence(r, config),
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
export const app = createApp(store, new SessionRegistry());
