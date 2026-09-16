#!/usr/bin/env npx tsx
/**
 * Simulated receiver — single-phone counterpart for demos and pipeline tests.
 *
 * Reads the transmitter's announced hotspot from the session, then posts the
 * exact report shape the real receiver app posts: a BLE reading of the
 * transmitter (carrying a valid rolling code), the joined WiFi, and the
 * ultrasonic stamp. Prints the server's presence verdict + link stats each
 * tick, so the transmitter's ROOM MONITOR shows a live "found device".
 *
 *   npx tsx scripts/simulate-receiver.ts \
 *     --server http://localhost:8787 \
 *     --session sess-1 --secret shusseki-preset-1-secret
 */
import {
  encodeBase64Utf8,
  simulateReceiverReport,
  summarizeLink,
  type DeviceReport,
  type LinkSummary,
} from "shared";

interface Args {
  server: string;
  session: string;
  room: string;
  secret: string;
  device: string;
  intervalMs: number;
  txRssi: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  return {
    server: get("--server", "http://localhost:8787"),
    session: get("--session", "sess-1"),
    room: get("--room", "room-1"),
    secret: get("--secret", "shusseki-preset-1-secret"),
    device: get("--device", `sim-rx-${Date.now().toString(36).slice(-4)}`),
    intervalMs: Number(get("--interval", "5000")),
    txRssi: Number(get("--tx-rssi", "-55")),
  };
}

interface AnnouncedHotspot {
  deviceId: string;
  ssid: string;
  passphrase: string | null;
}

async function ensureSession(args: Args): Promise<void> {
  const res = await fetch(`${args.server}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: args.session,
      roomId: args.room,
      secret: encodeBase64Utf8(args.secret),
    }),
  });
  if (!res.ok && res.status !== 201) {
    throw new Error(`ensure session failed: ${res.status}`);
  }
}

async function fetchHotspot(args: Args): Promise<AnnouncedHotspot | null> {
  const res = await fetch(`${args.server}/api/sessions/${args.session}/hotspot`);
  if (!res.ok) return null;
  const body = (await res.json()) as { hotspot?: AnnouncedHotspot | null };
  return body.hotspot ?? null;
}

interface PresenceResponse {
  presence?: {
    present: boolean;
    fused: number;
    ultrasonicServerValid: boolean | null;
    link?: LinkSummary;
  };
}

function chips(link: LinkSummary | undefined): string {
  if (!link) return "no link";
  const g = { connected: "●", degraded: "◐", lost: "○" } as const;
  return link.modalities.map((m) => `${m.modality[0]!.toUpperCase()}${g[m.state]}`).join(" ");
}

async function postReport(args: Args, report: DeviceReport): Promise<PresenceResponse["presence"]> {
  const res = await fetch(`${args.server}/api/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  if (!res.ok) throw new Error(`report rejected: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as PresenceResponse;
  return body.presence ?? undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const secretBytes = new TextEncoder().encode(args.secret);
  await ensureSession(args);
  console.log(
    `[sim] session=${args.session} room=${args.room} device=${args.device} server=${args.server}`,
  );

  let announced: AnnouncedHotspot | null = null;
  let lastSsid: string | null = null;
  const tick = async () => {
    const hotspot = await fetchHotspot(args);
    if (hotspot?.ssid !== lastSsid) {
      announced = hotspot;
      lastSsid = hotspot?.ssid ?? null;
      console.log(
        hotspot
          ? `[sim] transmitter found: ${hotspot.ssid} @ ${hotspot.deviceId}`
          : "[sim] no transmitter announced yet (waiting for TX ENGAGE)",
      );
    }
    if (hotspot) announced = hotspot;

    const now = Date.now();
    const report = simulateReceiverReport({
      deviceId: args.device,
      roomId: args.room,
      sessionId: args.session,
      now,
      secret: secretBytes,
      transmitter: announced
        ? { nodeId: announced.deviceId, ssid: announced.ssid, rssi: args.txRssi }
        : null,
    });
    const presence = await postReport(args, report);
    const link = presence?.link ?? summarizeLink(report);
    console.log(
      `[sim] report ${new Date(now).toLocaleTimeString()} · present=${presence?.present ?? "?"} fused=${(presence?.fused ?? 0).toFixed(2)} codeValid=${presence?.ultrasonicServerValid ?? "?"} · ${chips(link)} · ${Math.round((link.quality ?? 0) * 100)}%`,
    );
  };

  await tick();
  const timer = setInterval(() => {
    void tick().catch((e) => console.error("[sim] tick failed:", e));
  }, args.intervalMs);

  process.on("SIGINT", () => {
    clearInterval(timer);
    console.log("\n[sim] stopped");
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("[sim] fatal:", e);
  process.exit(1);
});
