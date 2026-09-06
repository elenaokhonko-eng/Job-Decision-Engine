import crypto from "crypto";
import type express from "express";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function bearerFromAuthorizationHeader(value: string | undefined): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1].trim();
}

export function apiAuthMiddleware(): express.RequestHandler {
  return (req, res, next) => {
    const requiredToken = (process.env.JDEC_API_TOKEN || process.env.API_TOKEN || "").trim();
    if (!requiredToken) {
      if (process.env.NODE_ENV === "production") {
        res.status(500).json({
          ok: false,
          error: "Server misconfigured: set JDEC_API_TOKEN (or API_TOKEN) to enable /api/v2 authentication.",
        });
        return;
      }
      return next();
    }

    const provided = bearerFromAuthorizationHeader(req.header("authorization"));
    if (!provided || !safeEqual(provided, requiredToken)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="job-decision-engine", charset="UTF-8"');
      res.status(401).json({ ok: false, error: "Unauthorized." });
      return;
    }

    return next();
  };
}

