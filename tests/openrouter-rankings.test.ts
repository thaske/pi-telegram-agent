import { expect, spyOn, test } from "bun:test";

import { getCachedOpenRouterPopularityRanks, getOpenRouterPopularityRanks } from "../src/openrouter-rankings";

test("optional rankings return immediately, share one refresh, and cache offline failures", async () => {
  const gate = Promise.withResolvers<Response>();
  const signals: Array<AbortSignal | null | undefined> = [];
  const fetchMock = Object.assign((...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
    signals.push(args[1]?.signal);
    return gate.promise;
  }, { preconnect: globalThis.fetch.preconnect });
  const request = spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  try {
    expect(getCachedOpenRouterPopularityRanks()).toBeUndefined();
    expect(getCachedOpenRouterPopularityRanks()).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2); // rankings page and model catalog, not two refreshes
    const waiting = getOpenRouterPopularityRanks();
    gate.reject(new Error("offline"));
    const ranks = await waiting;
    const requests = request.mock.calls.length;
    expect(ranks.size).toBe(0);
    expect(getCachedOpenRouterPopularityRanks()).toBe(ranks);
    expect(await getOpenRouterPopularityRanks()).toBe(ranks);
    expect(request.mock.calls.length).toBe(requests);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  } finally {
    gate.reject(new Error("finished"));
    await getOpenRouterPopularityRanks();
    request.mockRestore();
  }
});
