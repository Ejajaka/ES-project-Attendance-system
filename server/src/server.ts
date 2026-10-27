import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { app, sessions, store } from "./index";
import type { SerializedSession } from "./sessions";
import type { StoreSnapshot } from "./store";

app.use(async (c, next) => {
  console.log("REQ", c.req.method, c.req.url);
  await next();
});

const port = Number(process.env.PORT ?? 8787);

// Optional JSON-file persistence: set SHUSSEKI_DATA to a path to survive
// restarts (the in-memory store otherwise resets on every boot). Cloudflare
// Workers deploys `app` without this file-backed bootstrap.
const dataPath = process.env.SHUSSEKI_DATA;

interface SavedData {
  store?: Partial<StoreSnapshot>;
  sessions?: SerializedSession[];
}

if (dataPath) {
  if (existsSync(dataPath)) {
    try {
      const parsed = JSON.parse(readFileSync(dataPath, "utf8")) as SavedData | Partial<StoreSnapshot>;
      if (parsed && typeof parsed === "object" && "store" in parsed) {
        const saved = parsed as SavedData;
        store.restore(saved.store ?? {});
        sessions.restore(saved.sessions ?? []);
      } else {
        // Backward compat: the old file was the store snapshot only.
        store.restore(parsed as Partial<StoreSnapshot>);
      }
      console.log(`Loaded saved state from ${dataPath}`);
    } catch (e) {
      console.warn(`Could not load ${dataPath}:`, e);
    }
  }
  const persist = () => {
    try {
      // Persist the store AND the calibrated session configs (thresholds,
      // room node, paused) so a restart doesn't force a re-calibration.
      writeFileSync(
        dataPath,
        JSON.stringify({ store: store.snapshot(), sessions: sessions.snapshot() }),
      );
    } catch (e) {
      console.warn("persist failed:", e);
    }
  };
  const timer = setInterval(persist, 5000);
  timer.unref?.();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      persist();
      process.exit(0);
    });
  }
  console.log(`Persisting state to ${dataPath} (every 5s)`);
}

console.log(`Shusseki fusion server listening on http://localhost:${port}`);
// Dev/self-host bootstrap (Node). For Cloudflare Workers, deploy `app` directly
// (Hono apps are Workers-compatible: `export default app`).
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
