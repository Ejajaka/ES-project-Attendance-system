import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { app, store } from "./index";

app.use(async (c, next) => {
  console.log("REQ", c.req.method, c.req.url);
  await next();
});

const port = Number(process.env.PORT ?? 8787);

// Optional JSON-file persistence: set SHUSSEKI_DATA to a path to survive
// restarts (the in-memory store otherwise resets on every boot). Cloudflare
// Workers deploys `app` without this file-backed bootstrap.
const dataPath = process.env.SHUSSEKI_DATA;
if (dataPath) {
  if (existsSync(dataPath)) {
    try {
      store.restore(JSON.parse(readFileSync(dataPath, "utf8")));
      console.log(`Loaded saved state from ${dataPath}`);
    } catch (e) {
      console.warn(`Could not load ${dataPath}:`, e);
    }
  }
  const persist = () => {
    try {
      writeFileSync(dataPath, JSON.stringify(store.snapshot()));
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
