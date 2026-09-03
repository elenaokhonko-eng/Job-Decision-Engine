import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { db } from "./src/db/db.ts";
import { runAgent } from "./src/services/agent.ts";

// Load environment variables
dotenv.config();

function isResetRouteAllowed(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  return process.env.ALLOW_RESET_ROUTE === "true";
}

type AsyncRoute = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void> | void;
function asyncHandler(handler: AsyncRoute) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Enable JSON request parsing
  app.use(express.json());

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      hasGeminiKey: !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY"
    });
  });

  // Get all jobs in database
  app.get("/api/jobs", asyncHandler(async (_req, res) => {
    const jobs = await db.queryJobs();
    res.json({ success: true, jobs });
  }));

  // Add a new job description to local database
  app.post("/api/jobs", async (req, res) => {
    try {
      const { title, company, source, description, salaryRange, location, careers_portal_url } = req.body;
      if (!title || !company || !source || !description) {
        res.status(400).json({ success: false, error: "Missing required fields (title, company, source, description)" });
        return;
      }
      const newJob = await db.addRawJob({
        title,
        company_name: company,
        source,
        raw_description: description,
        salary_range: salaryRange,
        posted_date: new Date().toISOString().split("T")[0],
        location,
        careers_portal_url: careers_portal_url || `https://www.${company.toLowerCase().replace(/[^a-z0-9]/g, "")}.com/careers`
      });
      res.status(201).json({ success: true, job: newJob });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Delete a job description
  app.delete("/api/jobs/:id", asyncHandler(async (req, res) => {
    const success = await db.deleteJob(req.params.id);
    res.json({ success });
  }));

  // Ask the agent / evaluate question
  app.post("/api/ask", async (req, res) => {
    try {
      const { question } = req.body;
      if (!question || question.trim() === "") {
        res.status(400).json({ success: false, error: "Question query is required" });
        return;
      }

      // Check if API Key is configured before invoking the agent
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "") {
        res.status(400).json({
          success: false,
          error: "CRITICAL CONFIGURATION ERROR: GEMINI_API_KEY environment variable is not configured. Please add GEMINI_API_KEY in the Secrets / Settings panel in the AI Studio UI to start using the Decision Engine."
        });
        return;
      }

      const { result, trace, toolsUsed } = await runAgent(question);
      res.json({
        success: true,
        result,
        trace,
        toolsUsed
      });
    } catch (err: any) {
      console.error("Agent execution error:", err);
      res.status(500).json({
        success: false,
        error: err.message || "An unexpected error occurred during evaluation."
      });
    }
  });

  // Get interaction logs
  app.get("/api/interactions", asyncHandler(async (_req, res) => {
    const interactions = await db.getInteractions();
    res.json({ success: true, interactions });
  }));

  // Get workplace culture aggregates and toxic blacklists
  app.get("/api/analytics", asyncHandler(async (_req, res) => {
    const analytics = await db.getNdCultureAnalytics();
    res.json({ success: true, analytics });
  }));

  // Reset database state to original seeded value
  app.post("/api/reset", asyncHandler(async (_req, res) => {
    if (!isResetRouteAllowed()) {
      res.status(403).json({ success: false, error: "Reset route is disabled." });
      return;
    }
    await db.resetToDefaults();
    res.json({ success: true, message: "Database reset to original seed state successfully." });
  }));

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Unhandled API error:", err);
    if (res.headersSent) {
      return;
    }
    res.status(500).json({
      success: false,
      error: err?.message || "An unexpected error occurred.",
    });
  });

  // Vite Integration
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Job Decision Engine Backend] Server running on http://0.0.0.0:${PORT}`);
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === "MY_GEMINI_API_KEY") {
      console.warn("⚠️  [WARNING]: GEMINI_API_KEY is not set. Real-time evaluation requests will fail until configured in Settings.");
    }
  });
}

startServer().catch((err) => {
  console.error("Fatal server startup error:", err);
});
