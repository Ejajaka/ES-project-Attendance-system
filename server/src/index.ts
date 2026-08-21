import { Hono } from "hono";
import {
  parseDeviceReport,
  evaluateInstances,
  roomCountError,
  type GroundTruth,
  type DeviceReport,
} from "shared";
import { computeDevicePresence } from "./presence";
import { MemoryStore, type Store } from "./store";
import { SessionRegistry, type CreateSessionInput } from "./sessions";

/**
 * Shusseki fusion server. Ingests Soshin/Jushin reports, computes per-modality
 * + fused presence, and evaluates against manual ground truth. Deployable on
 * Node (`tsx src/server.ts`) or Cloudflare Workers (Hono is runtime-agnostic).
 */

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

export const app = createApp(new MemoryStore(), new SessionRegistry());
