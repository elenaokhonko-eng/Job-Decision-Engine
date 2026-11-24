/** Response-schema converters for Gemini and OpenAI strict mode. Pure functions. */

/**
 * The response schema as sent to Gemini. Gemini rejects schemas whose constraint state is too
 * large with 400 INVALID_ARGUMENT; an array cap such as maxItems: 25 over items with enum fields is
 * enough to trigger it. Array caps are therefore left out of the request; callers still enforce
 * them when they validate the response locally.
 */
export function geminiResponseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiResponseSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([key]) => key !== "maxItems")
      .map(([key, value]) => {
        if (key === "enum") return [key, value];
        // Keys under "properties" are field names, so only their schemas are rewritten.
        if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
          return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, geminiResponseSchema(child)]))];
        }
        return [key, geminiResponseSchema(value)];
      })
  );
}

// OpenAI strict structured outputs reject string length bounds; callers still enforce them when
// they validate the response locally. Array bounds, number ranges, pattern and enum are supported.
const OPENAI_STRICT_UNSUPPORTED_KEYWORDS = new Set(["minLength", "maxLength"]);

function nullableSchema(schema: unknown): unknown {
  const record = schema && typeof schema === "object" && !Array.isArray(schema) ? schema as Record<string, unknown> : null;
  if (record && Array.isArray(record.anyOf)) {
    const hasNull = record.anyOf.some((option) => (option as Record<string, unknown> | null)?.type === "null");
    return hasNull ? record : { ...record, anyOf: [...record.anyOf, { type: "null" }] };
  }
  return { anyOf: [schema, { type: "null" }] };
}

/**
 * The response schema as sent to OpenAI with strict: true. Strict mode requires every object to
 * list all of its properties in `required` and to forbid additional properties, so a property the
 * caller left optional is sent as required-but-nullable, and unsupported keywords are dropped.
 */
export function openAiStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(openAiStrictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const source = schema as Record<string, unknown>;
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (OPENAI_STRICT_UNSUPPORTED_KEYWORDS.has(key) || key === "required" || key === "properties" || key === "additionalProperties") continue;
    converted[key] = key === "enum" ? value : openAiStrictSchema(value);
  }
  const properties = source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
    ? source.properties as Record<string, unknown>
    : null;
  if (properties || source.type === "object") {
    const required = new Set(Array.isArray(source.required) ? source.required as string[] : []);
    // Keys under "properties" are field names, so only their schemas are rewritten.
    converted.properties = Object.fromEntries(Object.entries(properties ?? {}).map(([name, child]) => {
      const strictChild = openAiStrictSchema(child);
      return [name, required.has(name) ? strictChild : nullableSchema(strictChild)];
    }));
    converted.required = Object.keys(properties ?? {});
    converted.additionalProperties = false;
  }
  return converted;
}
