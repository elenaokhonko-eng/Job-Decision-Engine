import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateCoverLetterDocx } from "../../services/renderers/docx_cl_renderer.js";

describe("generateCoverLetterDocx", () => {
  it("rejects a missing candidate name instead of rendering a fallback identity", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jdec-cover-letter-"));
    const outputPath = path.join(directory, "cover-letter.docx");
    const coverLetter = {
      cover_letter: {
        recipient_name: "Hiring Manager",
        opening_hook: "A concise opening.",
        body_paragraphs: ["A grounded paragraph."],
        closing_statement: "Thank you for your consideration.",
      },
    };

    try {
      await expect(generateCoverLetterDocx(coverLetter, outputPath, {})).rejects.toThrow(/candidate name/i);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
