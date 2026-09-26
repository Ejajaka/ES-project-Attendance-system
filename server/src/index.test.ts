import { test, expect } from "vitest";
import { generateTOTP } from "shared";
import { createApp } from "./index";
import { MemoryStore } from "./store";
import { SessionRegistry } from "./sessions";

const SECRET = new TextEncoder().encode("session-shared-secret");
const SECRET_B64 = Buffer.from(SECRET).toString("base64");
const STEP_MS = 30 * 1000;
const ALIGNED = Math.floor(1_700_000_000 / STEP_MS) * STEP_MS;

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
  expect(students).toEqual([{ studentId: "bl.9", name: "Zed" }]);
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
