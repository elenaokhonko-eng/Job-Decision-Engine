import express from "express";
import dotenv from "dotenv";

import { createApiV2Router } from "../src/api/v2/router.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

async function start(): Promise<void> {
  const rawPort = String(process.env.PORT || "").trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : 3000;

  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.use("/api/v2", createApiV2Router());

  await new Promise<void>((resolve) => {
    app.listen(port, "127.0.0.1", () => resolve());
  });

  console.log(`API v2 server listening on http://127.0.0.1:${port}`);
}

start().catch((err) => {
  console.error("❌ Failed to start API v2 server:", err?.message ?? err);
  process.exit(1);
});

