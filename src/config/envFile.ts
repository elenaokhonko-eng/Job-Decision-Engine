/**
 * Pure helpers for merging values into the text of a dotenv file. The setup command uses them to
 * write `.env.local` without discarding anything the user already set.
 */

const ENV_LINE = /^([A-Z0-9_]+)=/;

/** Quotes a value only when dotenv would otherwise misread it. */
export function quoteEnvValue(value: string): string {
  if (value === "" || /[\s#"'\\]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

/** A value that would break the line structure of the file (newline or carriage return). */
export function isUnsafeEnvValue(value: string): boolean {
  return /[\r\n\0]/.test(value);
}

/**
 * Returns `existing` with each key replaced in place (first occurrence) or appended. Comments,
 * blank lines and the order of untouched keys are preserved. Throws on a value containing a line
 * break, which would let one value inject another variable.
 */
export function mergeEnvText(existing: string, values: Record<string, string>): string {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z0-9_]+$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    if (isUnsafeEnvValue(value)) throw new Error(`The value for ${key} contains a line break and was not written.`);
  }

  const pending = new Map(Object.entries(values));
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];

  const updated = lines.map((line) => {
    const match = ENV_LINE.exec(line);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]) as string;
    pending.delete(match[1]);
    return `${match[1]}=${quoteEnvValue(value)}`;
  });

  for (const [key, value] of pending) {
    updated.push(`${key}=${quoteEnvValue(value)}`);
  }
  return `${updated.join("\n").replace(/\n+$/, "")}\n`;
}
