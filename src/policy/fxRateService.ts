import pg from "pg";
import { sha256Hex, stableStringify } from "../config/structuredLoader.js";

const FRANKFURTER_LATEST_URL = "https://api.frankfurter.app/latest";
const DEFAULT_TIMEOUT_MS = 8_000;

export interface FxRateObservation {
  readonly id: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: "SGD";
  readonly rate: number;
  readonly rateDate: string;
  readonly sourceName: "FRANKFURTER";
  readonly sourceUrl: string;
  readonly sourceContentHash: string;
  readonly retrievedAt: string;
}

export interface ResolveFxRateOptions {
  readonly maxAgeDays: number;
  readonly now?: Date;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
}

export class FxRateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FxRateUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freshEnough(rateDate: string, now: Date, maxAgeDays: number): boolean {
  const parsed = new Date(rateDate);
  if (!Number.isFinite(parsed.getTime())) return false;
  const ageDays = Math.floor((now.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1000));
  return ageDays >= 0 && ageDays <= maxAgeDays;
}

export async function resolveFrankfurterSgdRate(
  executor: pg.Pool | pg.PoolClient,
  rawCurrency: string,
  options: ResolveFxRateOptions,
): Promise<FxRateObservation> {
  const baseCurrency = rawCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(baseCurrency)) {
    throw new FxRateUnavailableError("FX base currency is not a valid ISO-4217 code.");
  }
  if (baseCurrency === "SGD") {
    return {
      id: "identity:SGD:SGD",
      baseCurrency,
      quoteCurrency: "SGD",
      rate: 1,
      rateDate: (options.now ?? new Date()).toISOString().slice(0, 10),
      sourceName: "FRANKFURTER",
      sourceUrl: "https://api.frankfurter.app/",
      sourceContentHash: sha256Hex("SGD:SGD:1"),
      retrievedAt: (options.now ?? new Date()).toISOString(),
    };
  }

  const now = options.now ?? new Date();
  const cached = await executor.query<{
    id: string;
    rate: string | number;
    rate_date: string | Date;
    source_name: string;
    source_url: string;
    source_content_hash: string;
    retrieved_at: string | Date;
  }>(
    `SELECT id, rate, rate_date, source_name, source_url, source_content_hash, retrieved_at
     FROM fx_rate_observations
     WHERE base_currency = $1 AND quote_currency = 'SGD' AND source_name = 'FRANKFURTER'
     ORDER BY rate_date DESC, retrieved_at DESC
     LIMIT 1`,
    [baseCurrency],
  );
  const cachedRow = cached.rows[0];
  if (cachedRow && freshEnough(String(cachedRow.rate_date).slice(0, 10), now, options.maxAgeDays)) {
    return {
      id: cachedRow.id,
      baseCurrency,
      quoteCurrency: "SGD",
      rate: Number(cachedRow.rate),
      rateDate: String(cachedRow.rate_date).slice(0, 10),
      sourceName: "FRANKFURTER",
      sourceUrl: cachedRow.source_url,
      sourceContentHash: cachedRow.source_content_hash,
      retrievedAt: new Date(cachedRow.retrieved_at).toISOString(),
    };
  }

  const url = new URL(FRANKFURTER_LATEST_URL);
  url.searchParams.set("from", baseCurrency);
  url.searchParams.set("to", "SGD");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let payload: unknown;
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new FxRateUnavailableError(`Frankfurter returned HTTP ${response.status}.`);
    }
    payload = await response.json();
  } catch (error) {
    if (error instanceof FxRateUnavailableError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new FxRateUnavailableError(`Frankfurter rate retrieval failed: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!isRecord(payload) || payload.base !== baseCurrency || typeof payload.date !== "string" || !isRecord(payload.rates)) {
    throw new FxRateUnavailableError("Frankfurter response did not match the expected rate schema.");
  }
  const rate = payload.rates.SGD;
  const rateDate = new Date(payload.date);
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(rateDate.getTime())) {
    throw new FxRateUnavailableError("Frankfurter response contained an invalid rate or date.");
  }
  const normalizedRateDate = rateDate.toISOString().slice(0, 10);
  if (!freshEnough(normalizedRateDate, now, options.maxAgeDays)) {
    throw new FxRateUnavailableError(`Frankfurter rate date ${normalizedRateDate} is outside the ${options.maxAgeDays}-day freshness window.`);
  }
  const sourceContentHash = sha256Hex(stableStringify(payload));
  const insert = await executor.query<{ id: string }>(
    `INSERT INTO fx_rate_observations (
       base_currency, quote_currency, rate, rate_date, source_name, source_url, source_content_hash, retrieved_at
     ) VALUES ($1, 'SGD', $2, $3::date, 'FRANKFURTER', $4, $5, $6)
     ON CONFLICT (base_currency, quote_currency, rate_date, source_name, source_content_hash) DO NOTHING
     RETURNING id`,
    [baseCurrency, rate, normalizedRateDate, url.toString(), sourceContentHash, now.toISOString()],
  );
  const id = insert.rows[0]?.id ?? (await executor.query<{ id: string }>(
    `SELECT id FROM fx_rate_observations
     WHERE base_currency = $1 AND quote_currency = 'SGD' AND rate_date = $2::date
       AND source_name = 'FRANKFURTER' AND source_content_hash = $3
     LIMIT 1`,
    [baseCurrency, normalizedRateDate, sourceContentHash],
  )).rows[0]?.id;
  if (!id) throw new FxRateUnavailableError("FX observation was not durably recorded.");
  return {
    id,
    baseCurrency,
    quoteCurrency: "SGD",
    rate,
    rateDate: normalizedRateDate,
    sourceName: "FRANKFURTER",
    sourceUrl: url.toString(),
    sourceContentHash,
    retrievedAt: now.toISOString(),
  };
}
