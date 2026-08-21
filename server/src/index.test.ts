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
});

test("GET presence 404s for an unknown session", async () => {
  const app = makeApp();
  const res = await app.request("/api/sessions/nope/presence");
  expect(res.status).toBe(404);
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
