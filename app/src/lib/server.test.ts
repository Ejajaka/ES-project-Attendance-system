import { test, expect, vi, afterEach } from "vitest";
import {
  announceHotspot,
  ensureSession,
  fetchHotspot,
  fetchSessionPresence,
} from "./server";

/**
 * Hotspot discovery: the transmitter announces its live LocalOnlyHotspot to
 * the session; receivers poll it and auto-join instead of transcribing an
 * Android-generated SSID.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("fetchHotspot returns the announced hotspot", async () => {
  const fetchMock = vi.fn(async () =>
    jsonResponse({
      hotspot: {
        sessionId: "s1",
        deviceId: "tx-1",
        ssid: "AndroidShare_1234",
        passphrase: "abcd1234",
        at: 1,
      },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const h = await fetchHotspot("http://server", "s1");
  expect(h?.ssid).toBe("AndroidShare_1234");
  expect(h?.passphrase).toBe("abcd1234");
  expect(fetchMock).toHaveBeenCalledWith(
    "http://server/api/sessions/s1/hotspot",
  );
});

test("fetchHotspot returns null when none was announced", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ hotspot: null })));
  expect(await fetchHotspot("http://server", "s1")).toBeNull();
});

test("fetchHotspot returns null when the server is unreachable", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("connection refused");
    }),
  );
  expect(await fetchHotspot("http://server", "s1")).toBeNull();
});

test("announceHotspot POSTs the SSID and passphrase", async () => {
  const fetchMock = vi.fn(async () => jsonResponse({ ok: true }, 201));
  vi.stubGlobal("fetch", fetchMock);

  const ok = await announceHotspot("http://server", "s1", {
    deviceId: "tx-1",
    ssid: "AndroidShare_1234",
    passphrase: "abcd1234",
  });
  expect(ok).toBe(true);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://server/api/sessions/s1/hotspot");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({
    deviceId: "tx-1",
    ssid: "AndroidShare_1234",
    passphrase: "abcd1234",
  });
});

test("announceHotspot reports failure instead of throwing", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network down");
    }),
  );
  const ok = await announceHotspot("http://server", "s1", {
    deviceId: "tx-1",
    ssid: "AndroidShare_1234",
  });
  expect(ok).toBe(false);
});

test("fetchSessionPresence returns devices and the round-trip time", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse({ devices: [{ deviceId: "d1", fused: 0.9 }] }),
    ),
  );
  const snap = await fetchSessionPresence("http://server", "s1");
  expect(snap.devices).toHaveLength(1);
  expect(snap.devices[0]!.deviceId).toBe("d1");
  expect(snap.rttMs).toBeGreaterThanOrEqual(0);
});

test("fetchSessionPresence degrades to empty without throwing", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("connection refused");
    }),
  );
  const snap = await fetchSessionPresence("http://server", "s1");
  expect(snap.devices).toEqual([]);
  expect(snap.rttMs).toBeNull();
});

test("ensureSession base64-encodes the rolling-code secret", async () => {
  const fetchMock = vi.fn(async () => jsonResponse({ ok: true }, 201));
  vi.stubGlobal("fetch", fetchMock);

  const ok = await ensureSession("http://server", {
    sessionId: "s1",
    roomId: "r1",
    secret: "shusseki-preset-1-secret",
  });
  expect(ok).toBe(true);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://server/api/sessions");
  expect(JSON.parse(String(init.body))).toEqual({
    sessionId: "s1",
    roomId: "r1",
    secret: "c2h1c3Nla2ktcHJlc2V0LTEtc2VjcmV0",
  });
});
