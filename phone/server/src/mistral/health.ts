/**
 * Lightweight, non-throwing liveness probe for a Mistral API key. Hits GET
 * /models (cheap, auth-gated) and reports whether the key is accepted — so a
 * revoked/expired key (401) surfaces clearly instead of silently failing every
 * screening call with a cryptic per-call error.
 */
export async function checkMistralKey(
  apiKey: string | undefined,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; status: number }> {
  if (!apiKey || apiKey === "replace-me") return { ok: false, status: 0 };
  try {
    const res = await fetchImpl(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: -1 };
  }
}
