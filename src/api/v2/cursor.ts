export interface CompositeCursor {
  t: string;
  id: string;
}

export function encodeCursor(cursor: CompositeCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined | null): CompositeCursor | null {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CompositeCursor>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.t !== "string" || typeof parsed.id !== "string") return null;
    if (!parsed.t.trim() || !parsed.id.trim()) return null;
    return { t: parsed.t, id: parsed.id };
  } catch {
    return null;
  }
}

