import { app } from "./index";

const port = Number(process.env.PORT ?? 8787);

console.log(`Shusseki fusion server listening on http://localhost:${port}`);
// Dev/self-host bootstrap (Bun). For Cloudflare Workers, deploy `app` directly
// (Hono apps are Workers-compatible: `export default app`).
Bun.serve({ fetch: app.fetch, port });
