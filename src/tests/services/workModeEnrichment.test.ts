import { describe, it, expect, vi } from "vitest";
import {
  extractWorkModeFromJsonLd,
  extractWorkModeFromHtml,
  computeEnrichmentFingerprint,
} from "../../services/workModeEnrichment.js";

describe("Work Mode Enrichment", () => {
  describe("extractWorkModeFromJsonLd", () => {
    it("extracts REMOTE from TELECOMMUTE jobLocationType", () => {
      const html = `
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org/",
                "@type": "JobPosting",
                "title": "Senior AI Engineer",
                "jobLocationType": "TELECOMMUTE"
              }
            </script>
          </head>
        </html>
      `;
      expect(extractWorkModeFromJsonLd(html)).toBe("REMOTE");
    });

    it("extracts REMOTE from nested jobLocationType in array", () => {
      const html = `
        <html>
          <body>
            <script type="application/ld+json">
              [
                { "@type": "Organization", "name": "Tech Corp" },
                {
                  "@type": "JobPosting",
                  "title": "Data Platform Architect",
                  "jobLocationType": ["TELECOMMUTE"]
                }
              ]
            </script>
          </body>
        </html>
      `;
      expect(extractWorkModeFromJsonLd(html)).toBe("REMOTE");
    });

    it("extracts HYBRID from workplaceType", () => {
      const html = `
        <script type="application/ld+json">
          {
            "@type": "JobPosting",
            "workplaceType": "hybrid",
            "description": "Flexible workplace"
          }
        </script>
      `;
      expect(extractWorkModeFromJsonLd(html)).toBe("HYBRID");
    });

    it("returns null if no JSON-LD or no work mode in JSON-LD", () => {
      const html = `<html><body><h1>No structured data</h1></body></html>`;
      expect(extractWorkModeFromJsonLd(html)).toBeNull();
    });
  });

  describe("extractWorkModeFromHtml", () => {
    it("extracts REMOTE from HTML badge or meta text", () => {
      const html = `
        <div class="job-meta">
          <span class="badge">100% Remote</span>
        </div>
      `;
      expect(extractWorkModeFromHtml(html)).toBe("REMOTE");
    });

    it("extracts HYBRID from HTML schedule text", () => {
      const html = `
        <div class="job-details">
          <p>Workplace: Hybrid remote (2 days in office, 3 days remote)</p>
        </div>
      `;
      expect(extractWorkModeFromHtml(html)).toBe("HYBRID");
    });

    it("extracts ONSITE from HTML office requirement text", () => {
      const html = `
        <div class="job-details">
          <p>This is a 100% on-site role based in our Singapore headquarters.</p>
        </div>
      `;
      expect(extractWorkModeFromHtml(html)).toBe("ONSITE");
    });

    it("returns null when no conclusive work mode exists in HTML", () => {
      const html = `
        <div>
          <h2>About Us</h2>
          <p>We build great software for global enterprises.</p>
        </div>
      `;
      expect(extractWorkModeFromHtml(html)).toBeNull();
    });
  });

  describe("computeEnrichmentFingerprint", () => {
    it("produces deterministic SHA-256 hash", () => {
      const fp1 = computeEnrichmentFingerprint("v1", "https://example.com/job/123", "v1.0");
      const fp2 = computeEnrichmentFingerprint("v1", "https://example.com/job/123", "v1.0");
      const fp3 = computeEnrichmentFingerprint("v1", "https://example.com/job/456", "v1.0");

      expect(fp1).toBe(fp2);
      expect(fp1).toHaveLength(64);
      expect(fp1).not.toBe(fp3);
    });
  });
});
