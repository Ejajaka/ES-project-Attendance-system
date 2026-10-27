import type { SessionConfig } from "./presence";

export interface CreateSessionInput {
  sessionId: string;
  roomId: string;
  /** Base64-encoded shared secret the Soshin broadcasts as the rolling code. */
  secret: string;
  step?: number;
  digits?: number;
  window?: number;
  bleRule?: SessionConfig["bleRule"];
  bleRssiThreshold?: number;
  wifiRssiThreshold?: number;
  /** Set from the transmitter's hotspot announce (e.g. "esp32-tx1"). */
  roomNodeId?: string;
  ttlMs?: number;
  enterMs?: number;
  exitMs?: number;
  paused?: boolean;
  combiner?: SessionConfig["combiner"];
  weights?: SessionConfig["weights"];
  threshold?: number;
}

/** JSON-safe session config (secret stays base64) for `SHUSSEKI_DATA`. */
export type SerializedSession = CreateSessionInput;

/** In-memory registry of session fusion configs (prototype; not durable). */
export class SessionRegistry {
  private configs = new Map<string, SessionConfig>();

  create(input: CreateSessionInput): SessionConfig {
    const rollingSecret = new Uint8Array(Buffer.from(input.secret, "base64"));
    // A re-announce (the transmitter repeats POST /sessions every ~50 s) must
    // not wipe the room-node binding or tuned thresholds set after creation.
    const existing = this.configs.get(input.sessionId);
    const config: SessionConfig = {
      sessionId: input.sessionId,
      roomId: input.roomId,
      rollingSecret,
      step: input.step,
      digits: input.digits,
      window: input.window,
      bleRule: input.bleRule ?? existing?.bleRule,
      bleRssiThreshold: input.bleRssiThreshold ?? existing?.bleRssiThreshold,
      wifiRssiThreshold: input.wifiRssiThreshold ?? existing?.wifiRssiThreshold,
      roomNodeId: input.roomNodeId ?? existing?.roomNodeId,
      ttlMs: input.ttlMs ?? existing?.ttlMs,
      enterMs: input.enterMs ?? existing?.enterMs,
      exitMs: input.exitMs ?? existing?.exitMs,
      paused: input.paused ?? existing?.paused,
      combiner: input.combiner ?? existing?.combiner,
      weights: input.weights ?? existing?.weights,
      threshold: input.threshold ?? existing?.threshold,
    };
    this.configs.set(input.sessionId, config);
    return config;
  }

  /** The transmitter announces its hotspot; remember which node owns the room. */
  setRoomNode(sessionId: string, roomNodeId: string): SessionConfig | undefined {
    const config = this.configs.get(sessionId);
    if (config) config.roomNodeId = roomNodeId;
    return config;
  }

  /** Apply calibrated boundaries (and optionally dwell/TTL) to a session. */
  setThresholds(
    sessionId: string,
    t: {
      bleRssiThreshold?: number;
      wifiRssiThreshold?: number;
      ttlMs?: number;
      enterMs?: number;
      exitMs?: number;
    },
  ): SessionConfig | undefined {
    const config = this.configs.get(sessionId);
    if (!config) return undefined;
    if (t.bleRssiThreshold != null) config.bleRssiThreshold = t.bleRssiThreshold;
    if (t.wifiRssiThreshold != null) config.wifiRssiThreshold = t.wifiRssiThreshold;
    if (t.ttlMs != null) config.ttlMs = t.ttlMs;
    if (t.enterMs != null) config.enterMs = t.enterMs;
    if (t.exitMs != null) config.exitMs = t.exitMs;
    return config;
  }

  /** Freeze/unfreeze ingestion (clearing attendance pauses until resumed). */
  setPaused(sessionId: string, paused: boolean): SessionConfig | undefined {
    const config = this.configs.get(sessionId);
    if (config) config.paused = paused;
    return config;
  }

  get(sessionId: string): SessionConfig | undefined {
    return this.configs.get(sessionId);
  }

  /** Snapshot calibrated thresholds/room binding so a restart keeps them. */
  snapshot(): SerializedSession[] {
    return [...this.configs.values()].map((c) => ({
      sessionId: c.sessionId,
      roomId: c.roomId,
      secret: Buffer.from(c.rollingSecret).toString("base64"),
      step: c.step,
      digits: c.digits,
      window: c.window,
      bleRule: c.bleRule,
      bleRssiThreshold: c.bleRssiThreshold,
      wifiRssiThreshold: c.wifiRssiThreshold,
      roomNodeId: c.roomNodeId,
      ttlMs: c.ttlMs,
      enterMs: c.enterMs,
      exitMs: c.exitMs,
      paused: c.paused,
      combiner: c.combiner,
      weights: c.weights,
      threshold: c.threshold,
    }));
  }

  restore(list: SerializedSession[]): void {
    for (const s of list) this.create(s);
  }
}
