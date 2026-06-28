export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|secret|api[_-]?key|authorization/i.test(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = redact(entry);
    }
  }
  return output;
}
