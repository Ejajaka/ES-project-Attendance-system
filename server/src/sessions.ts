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
  combiner?: SessionConfig["combiner"];
  weights?: SessionConfig["weights"];
  threshold?: number;
}

/** In-memory registry of session fusion configs (prototype; not durable). */
export class SessionRegistry {
  private configs = new Map<string, SessionConfig>();

  create(input: CreateSessionInput): SessionConfig {
    const rollingSecret = new Uint8Array(Buffer.from(input.secret, "base64"));
    const config: SessionConfig = {
      sessionId: input.sessionId,
      roomId: input.roomId,
      rollingSecret,
      step: input.step,
      digits: input.digits,
      window: input.window,
      bleRule: input.bleRule,
      combiner: input.combiner,
      weights: input.weights,
      threshold: input.threshold,
    };
    this.configs.set(input.sessionId, config);
    return config;
  }

  get(sessionId: string): SessionConfig | undefined {
    return this.configs.get(sessionId);
  }
}
