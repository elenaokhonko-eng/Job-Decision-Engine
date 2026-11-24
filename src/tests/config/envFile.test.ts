import { describe, expect, it } from "vitest";
import { mergeEnvText, quoteEnvValue } from "../../config/envFile.js";

describe("mergeEnvText", () => {
  it("appends new keys and keeps a trailing newline", () => {
    expect(mergeEnvText("", { A: "1", B: "two" })).toBe("A=1\nB=two\n");
  });

  it("replaces an existing key in place and keeps comments, blanks and order", () => {
    const existing = "# database\nDATABASE_URL=old\n\nOTHER=keep\n";
    expect(mergeEnvText(existing, { DATABASE_URL: "new" })).toBe("# database\nDATABASE_URL=new\n\nOTHER=keep\n");
  });

  it("replaces only the first occurrence of a duplicated key", () => {
    expect(mergeEnvText("A=1\nA=2\n", { A: "9" })).toBe("A=9\nA=2\n");
  });

  it("handles CRLF input", () => {
    expect(mergeEnvText("A=1\r\nB=2\r\n", { A: "x" })).toBe("A=x\nB=2\n");
  });

  it("quotes values dotenv would misread", () => {
    expect(quoteEnvValue("plain")).toBe("plain");
    expect(quoteEnvValue("has space")).toBe('"has space"');
    expect(quoteEnvValue('a"b')).toBe('"a\\"b"');
    expect(quoteEnvValue("a#b")).toBe('"a#b"');
    expect(quoteEnvValue("")).toBe('""');
  });

  it("refuses a value with a line break, which could inject another variable", () => {
    expect(() => mergeEnvText("", { A: "x\nEVIL=1" })).toThrow(/line break/);
  });

  it("refuses an invalid variable name", () => {
    expect(() => mergeEnvText("", { "bad name": "x" })).toThrow(/Invalid environment variable name/);
  });
});
