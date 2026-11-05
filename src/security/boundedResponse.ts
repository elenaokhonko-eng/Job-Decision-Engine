export async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("Response byte limit must be a positive safe integer.");
  }
  const declaredLength = response.headers.get("content-length");
  const parsedLength = declaredLength === null ? null : Number(declaredLength);
  if (parsedLength !== null && Number.isFinite(parsedLength) && parsedLength > maxBytes) {
    await response.body?.cancel();
    throw new RangeError(`${label} exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new RangeError(`${label} exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function readJsonResponseBounded(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  return JSON.parse(await readResponseTextBounded(response, maxBytes, label)) as unknown;
}
