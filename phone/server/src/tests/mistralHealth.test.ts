import { describe, expect, test } from "vitest";
import { checkMistralKey } from "../mistral/health.js";

const BASE = "https://api.mistral.ai/v1";

function fakeFetch(status: number): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status })) as unknown as typeof fetch;
}

describe("checkMistralKey", () => {
  test("empty / placeholder key is not ok, status 0, no network call", async () => {
    expect(await checkMistralKey("", BASE, fakeFetch(200))).toEqual({ ok: false, status: 0 });
    expect(await checkMistralKey("replace-me", BASE, fakeFetch(200))).toEqual({ ok: false, status: 0 });
  });

  test("401 from the API means a dead/invalid key", async () => {
    expect(await checkMistralKey("deadkey", BASE, fakeFetch(401))).toEqual({ ok: false, status: 401 });
  });

  test("200 means the key is live", async () => {
    expect(await checkMistralKey("goodkey", BASE, fakeFetch(200))).toEqual({ ok: true, status: 200 });
  });

  test("network failure is reported as status -1, not a throw", async () => {
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await checkMistralKey("k", BASE, throwingFetch)).toEqual({ ok: false, status: -1 });
  });
});
