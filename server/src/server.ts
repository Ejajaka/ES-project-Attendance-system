import { serve } from "@hono/node-server";
import { app } from "./index";

app.use(async (c, next) => {
  console.log("REQ", c.req.method, c.req.url);
  await next();
});

const port = Number(process.env.PORT ?? 8787);

console.log(`Shusseki fusion server listening on http://localhost:${port}`);
// Dev/self-host bootstrap (Node). For Cloudflare Workers, deploy `app` directly
// (Hono apps are Workers-compatible: `export default app`).
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
