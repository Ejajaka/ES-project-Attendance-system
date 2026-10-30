import { test, expect } from "vitest";
import { generateTOTP } from "shared";
import { createApp } from "./index";
import { MemoryStore } from "./store";
import { SessionRegistry } from "./sessions";

const SECRET = new TextEncoder().encode("session-shared-secret");
const SECRET_B64 = Buffer.from(SECRET).toString("base64");
const STEP_MS = 30 * 1000;
// Recent, step-aligned: room presence has a 30 s freshness TTL.
const ALIGNED = Math.floor(Date.now() / STEP_MS) * STEP_MS;

function makeApp() {
  return createApp(new MemoryStore(), new SessionRegistry());
}

function reportPayload(code: string) {
  return {
    deviceId: "d1",
    mode: "jushin",
    roomId: "r1",
    sessionId: "s1",
    timestamp: ALIGNED,
    ble: { readings: [{ nodeId: "soshin", rssi: -55 }] },
    wifi: { connectedToSoshin: true, soshinRssi: -50 },
    ultrasonic: { received: true, valid: true, code },
  };
}

test("POST /api/sessions creates a session", async () => {
  const app = makeApp();
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "s1",
      roomId: "r1",
      secret: SECRET_B64,
      step: 30,
      digits: 6,
      window: 1,
      threshold: 0.5,
    }),
  });
  expect(res.status).toBe(201);
});

test("POST /api/reports rejects a report for an unknown session", async () => {
  const app = makeApp();
  const res = await app.request("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reportPayload("123456")),
  });
  expect(res.status).toBe(404);
});

test("full flow: create session, ingest report, read presence", async () => {
  const app = makeApp();
  await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "s1",
      roomId: "r1",
      secret: SECRET_B64,
      step: 30,
      digits: 6,
      window: 1,
      threshold: 0.5,
    }),
  });

  const code = generateTOTP(SECRET, ALIGNED, { step: 30 });
  const ingest = await app.request("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reportPayload(code)),
  });
  expect(ingest.status).toBe(200);
  const body = await ingest.json();
  expect(body.presence.present).toBe(true);

  const pres = await app.request("/api/sessions/s1/presence");
  expect(pres.status).toBe(200);
  const presBody = await pres.json();
  expect(presBody.devices).toHaveLength(1);
  expect(presBody.devices[0].present).toBe(true);
  // Monitors render per-channel link stats from the same response.
  expect(presBody.devices[0].link.state).toBe("connected");
  expect(presBody.devices[0].link.modalities).toHaveLength(3);
});

test("hotspot announce/read: a receiver can discover the transmitter's AP", async () => {
  const app = makeApp();
  await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "s1", roomId: "r1", secret: SECRET_B64 }),
  });

  const before = await app.request("/api/sessions/s1/hotspot");
  expect(before.status).toBe(200);
  expect((await before.json()).hotspot).toBeNull();

  const post = await app.request("/api/sessions/s1/hotspot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceId: "tx-1",
      ssid: "AndroidShare_1234",
      passphrase: "abcd1234",
    }),
  });
  expect(post.status).toBe(201);

  const after = await app.request("/api/sessions/s1/hotspot");
  expect(after.status).toBe(200);
  const { hotspot } = await after.json();
  expect(hotspot.ssid).toBe("AndroidShare_1234");
  expect(hotspot.passphrase).toBe("abcd1234");
  expect(hotspot.deviceId).toBe("tx-1");
});

test("hotspot announce rejects unknown sessions and missing SSIDs", async () => {
  const app = makeApp();
  const unknown = await app.request("/api/sessions/nope/hotspot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "tx-1", ssid: "x" }),
  });
  expect(unknown.status).toBe(404);

  await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "s1", roomId: "r1", secret: SECRET_B64 }),
  });
  const bad = await app.request("/api/sessions/s1/hotspot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "tx-1" }),
  });
  expect(bad.status).toBe(400);
});

test("GET presence 404s for an unknown session", async () => {
  const app = makeApp();
  const res = await app.request("/api/sessions/nope/presence");
  expect(res.status).toBe(404);
});

test("attendance: roster + reports produce a sheet, CSV and HTML", async () => {
  const app = makeApp();
  await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "s1", roomId: "r1", secret: SECRET_B64 }),
  });

  const roster = await app.request("/api/sessions/s1/roster", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      students: [
        { studentId: "bl.1", name: "Ada" },
        { studentId: "bl.2", name: "Bob" },
      ],
    }),
  });
  expect(roster.status).toBe(201);

  const code = generateTOTP(SECRET, ALIGNED, { step: 30 });
  const p = { ...reportPayload(code), studentId: "bl.1", deviceId: "phone-ada" };
  await app.request("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(p),
  });
  await app.request("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...p, timestamp: ALIGNED + 5000 }),
  });

  const att = await app.request("/api/sessions/s1/attendance");
  expect(att.status).toBe(200);
  const sheet = await att.json();
  expect(sheet.rosterCount).toBe(2);
  expect(sheet.presentCount).toBe(1);
  const ada = sheet.rows.find((r: { studentId: string }) => r.studentId === "bl.1");
  expect(ada.present).toBe(true);
  expect(ada.presentMs).toBe(5000);
  expect(sheet.rows.find((r: { studentId: string }) => r.studentId === "bl.2").present).toBe(
    false,
  );

  const csv = await app.request("/api/sessions/s1/attendance?format=csv");
  expect(csv.headers.get("content-type")).toContain("text/csv");
  expect(await csv.text()).toContain("Ada");

  const html = await app.request("/attendance/s1");
  expect(html.headers.get("content-type")).toContain("text/html");
  expect(await html.text()).toContain("Shusseki attendance");
});

test("attendance endpoints 404 for unknown sessions; bad roster 400s", async () => {
  const app = makeApp();
  expect((await app.request("/api/sessions/nope/attendance")).status).toBe(404);
  expect((await app.request("/attendance/nope")).status).toBe(404);

  await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "s1", roomId: "r1", secret: SECRET_B64 }),
  });
  const bad = await app.request("/api/sessions/s1/roster", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ students: [{ name: "no id" }] }),
  });
  expect(bad.status).toBe(400);
});

test("a report with studentId auto-enrolls the roster", async () => {
  const app = makeApp();
  await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "s1", roomId: "r1", secret: SECRET_B64 }),
  });
  const code = generateTOTP(SECRET, ALIGNED, { step: 30 });
  await app.request("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...reportPayload(code),
      deviceId: "phone-zed",
      studentId: "bl.9",
      studentName: "Zed",
    }),
  });
  const roster = await app.request("/api/sessions/s1/roster");
  const { students } = await roster.json();
  // Auto-enroll also binds the current phone so a swapped/reinstalled device
  // stays linked to the same student.
  expect(students).toEqual([
    { studentId: "bl.9", name: "Zed", deviceId: "phone-zed" },
  ]);
});

test("room feature: only the room node's BLE counts; corridor is out", async () => {
  const app = makeApp();
  await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "s1",
      roomId: "r1",
      secret: SECRET_B64,
      roomNodeId: "tx",
      bleRssiThreshold: -70,
      ttlMs: 60_000,
      enterMs: 0,
      exitMs: 0,
    }),
  });
  const code = generateTOTP(SECRET, ALIGNED, { step: 30 });
  const base = reportPayload(code);

  // Strong signal from a different room's node must not count.
  const wrong = await app.request("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...base,
      ble: { readings: [{ nodeId: "other-room", rssi: -40 }] },
      wifi: undefined,
      ultrasonic: undefined,
    }),
  });
  const wrongBody = await wrong.json();
  expect(wrongBody.presence.room.ble.inRoom).toBe(false);
  expect(wrongBody.presence.present).toBe(false);

  // The room node, close enough, is in-room.
  const right = await app.request("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...base,
      timestamp: ALIGNED + 1000,
      ble: { readings: [{ nodeId: "tx", rssi: -55 }] },
      wifi: undefined,
      ultrasonic: undefined,
    }),
  });
  const rightBody = await right.json();
  expect(rightBody.presence.room.ble.inRoom).toBe(true);
  expect(rightBody.presence.present).toBe(true);
});

test("calibration: suggests thresholds from inside/outside samples and applies them", async () => {
  const app = makeApp();
  await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "s1",
      roomId: "r1",
      secret: SECRET_B64,
      roomNodeId: "tx",
      ttlMs: 60_000,
      enterMs: 0,
      exitMs: 0,
    }),
  });
  const code = generateTOTP(SECRET, ALIGNED, { step: 30 });
  const base = reportPayload(code);
  const report = (deviceId: string, rssi: number) =>
    app.request("/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...base,
        deviceId,
        ble: { readings: [{ nodeId: "tx", rssi }] },
        wifi: undefined,
        ultrasonic: undefined,
      }),
    });

  await report("probe-inside", -55);
  const inMark = await app.request("/api/sessions/s1/calibrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "inside", deviceId: "probe-inside" }),
  });
  expect(inMark.status).toBe(201);

  await report("probe-outside", -85);
  await app.request("/api/sessions/s1/calibrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "outside", deviceId: "probe-outside" }),
  });

  const cal = await (await app.request("/api/sessions/s1/calibrate")).json();
  expect(cal.suggestion.bleRssiThreshold).toBe(-70);

  const apply = await app.request("/api/sessions/s1/calibrate/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect((await apply.json()).applied.bleRssiThreshold).toBe(-70);

  // With the applied threshold (-70 dBm), -75 is outside and -65 is inside.
  const outside = await (await report("probe-a", -75)).json();
  expect(outside.presence.room.ble.inRoom).toBe(false);
  const inside = await (await report("probe-b", -65)).json();
  expect(inside.presence.room.ble.inRoom).toBe(true);
});

test("adaptive baseline keeps a weak phone present once it has been close", async () => {
  const app = makeApp();
  await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "s1",
      roomId: "r1",
      secret: SECRET_B64,
      roomNodeId: "tx",
      ttlMs: 60_000,
      enterMs: 0,
      exitMs: 0,
    }),
  });
  const code = generateTOTP(SECRET, ALIGNED, { step: 30 });
  const base = reportPayload(code);
  const report = (deviceId: string, rssi: number) =>
    app.request("/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...base,
        deviceId,
        ble: { readings: [{ nodeId: "tx", rssi }] },
        wifi: undefined,
        ultrasonic: undefined,
      }),
    });

  // A phone that never reaches the -70 dBm threshold stays out.
  const far = await (await report("phone-far", -82)).json();
  expect(far.presence.room.ble.inRoom).toBe(false);

  // Once a phone hits the threshold, its own anchor allows a margin of drop.
  await report("phone-weak", -70);
  const weak = await (await report("phone-weak", -80)).json();
  expect(weak.presence.room.ble.inRoom).toBe(true);
});

test("attendance reset clears timelines but keeps the roster", async () => {
  const app = makeApp();
  await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "s1", roomId: "r1", secret: SECRET_B64 }),
  });
  await app.request("/api/sessions/s1/roster", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ students: [{ studentId: "bl.1", name: "Ada" }] }),
  });
  const code = generateTOTP(SECRET, ALIGNED, { step: 30 });
  await app.request("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...reportPayload(code),
      deviceId: "phone-ada",
      studentId: "bl.1",
    }),
  });
  const before = await (await app.request("/api/sessions/s1/attendance")).json();
  expect(before.presentCount).toBe(1);

  const reset = await app.request("/api/sessions/s1/attendance/reset", { method: "POST" });
  expect(reset.status).toBe(200);

  const after = await (await app.request("/api/sessions/s1/attendance")).json();
  expect(after.presentCount).toBe(0);
  expect(after.rosterCount).toBe(0); // roster cleared too
  expect(after.rows).toHaveLength(0);

  // While paused, a still-running phone must not re-fill the register.
  const ignored = await app.request("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...reportPayload(code),
      deviceId: "phone-ada",
      studentId: "bl.1",
      timestamp: ALIGNED + 1000,
    }),
  });
  expect((await ignored.json()).paused).toBe(true);
  const stillClear = await (await app.request("/api/sessions/s1/attendance")).json();
  expect(stillClear.presentCount).toBe(0);

  // Resume accepts reports again.
  await app.request("/api/sessions/s1/resume", { method: "POST" });
  await app.request("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...reportPayload(code),
      deviceId: "phone-ada",
      studentId: "bl.1",
      timestamp: ALIGNED + 2000,
    }),
  });
  const resumed = await (await app.request("/api/sessions/s1/attendance")).json();
  expect(resumed.presentCount).toBe(1);
});

test("GET /api/sessions/:id/evaluate reports room-level count error", async () => {
  const app = makeApp();
  await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "s1",
      roomId: "r1",
      secret: SECRET_B64,
      step: 30,
      digits: 6,
      window: 1,
      threshold: 0.5,
    }),
  });
  const code = generateTOTP(SECRET, ALIGNED, { step: 30 });
  await app.request("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reportPayload(code)),
  });
  await app.request("/api/sessions/s1/ground-truth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: "r1", headcount: 3, timestamp: ALIGNED }),
  });

  const evalRes = await app.request("/api/sessions/s1/evaluate");
  expect(evalRes.status).toBe(200);
  const ev = await evalRes.json();
  // 1 device predicted present vs headcount 3 => count error 2
  expect(ev.predictedPresent).toBe(1);
  expect(ev.headcount).toBe(3);
  expect(ev.countError).toBe(2);
});

test("live series + dashboard expose BLE/WiFi/SNR", async () => {
  const app = makeApp();
  await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "s1",
      roomId: "r1",
      secret: SECRET_B64,
      step: 30,
      digits: 6,
      window: 1,
      threshold: 0.5,
    }),
  });
  const code = generateTOTP(SECRET, ALIGNED, { step: 30 });
  await app.request("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reportPayload(code)),
  });

  const series = await app.request("/api/sessions/s1/series");
  expect(series.status).toBe(200);
  const body = (await series.json()) as {
    devices: { deviceId: string; points: { ble: number | null; wifi: number | null; snr: number | null }[] }[];
  };
  expect(body.devices).toHaveLength(1);
  const point = body.devices[0]!.points.at(-1)!;
  expect(point.ble).toBe(-55);
  expect(point.wifi).toBe(-50);
  expect(point.snr).toBeNull();

  const page = await app.request("/dashboard/s1");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");

  const unknown = await app.request("/api/sessions/nope/series");
  expect(unknown.status).toBe(404);
});
