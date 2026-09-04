import * as fs from 'fs/promises';
import * as path from 'path';
import crypto from 'crypto';
import * as yaml from 'js-yaml';
import { z } from 'zod';

export type StructuredFormat = 'json' | 'yaml';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && (value as any).constructor === Object;
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortRecursively);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortRecursively(value[key]);
    }
    return out;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortRecursively(value));
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export interface LoadedStructuredFile<T> {
  format: StructuredFormat;
  rawText: string;
  parsed: unknown;
  data: T;
  canonicalJson: string;
  contentHash: string;
}

function parseYaml(rawText: string): unknown {
  const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
  return loadFn(rawText) as unknown;
}

export async function loadStructuredFile<T>(
  filePath: string,
  schema: z.ZodType<T>
): Promise<LoadedStructuredFile<T>> {
  const ext = path.extname(filePath).toLowerCase();
  const rawText = await fs.readFile(filePath, 'utf-8');

  let parsed: unknown;
  let format: StructuredFormat;
  if (ext === '.json') {
    format = 'json';
    parsed = JSON.parse(rawText);
  } else if (ext === '.yml' || ext === '.yaml') {
    format = 'yaml';
    parsed = parseYaml(rawText);
  } else {
    throw new Error(`Unsupported structured file extension "${ext}" for ${filePath}`);
  }

  let data: T;
  try {
    data = schema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Validation failed for ${filePath}:\n${error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n')}`
      );
    }
    throw error;
  }

  const canonicalJson = stableStringify(data);
  const contentHash = sha256Hex(canonicalJson);

  return {
    format,
    rawText,
    parsed,
    data,
    canonicalJson,
    contentHash,
  };
}

