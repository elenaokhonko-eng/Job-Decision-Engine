import express from "express";
import dotenv from "dotenv";

import { createApiV2Router } from "../src/api/v2/router.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

async function start(): Promise<void> {
  const rawPort = String(process.env.PORT || "").trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : 3000;
  const host = String(
    process.env.API_HOST ||
      process.env.HOST ||
      (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1")
  ).trim();

  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }
  if (!host) {
    throw new Error("Invalid API_HOST: the managed API must bind to a non-empty host.");
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.use("/api/v2", createApiV2Router());

  await new Promise<void>((resolve) => {
    app.listen(port, host, () => resolve());
  });

  console.log(`API v2 server listening on http://${host}:${port}`);
}

start().catch((err) => {
  console.error("❌ Failed to start API v2 server:", err?.message ?? err);
  process.exit(1);
});
