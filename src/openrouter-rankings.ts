const RANKINGS_URL = "https://openrouter.ai/rankings";
const MODELS_URL = "https://openrouter.ai/api/v1/models";
const FALLBACK_MODEL_RANKINGS_ACTION_ID =
  "40824635c5eb77626bdf6795ffbf382c0862b321e1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type RankingRow = {
  model_permaslug?: string;
  variant_permaslug?: string;
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_native_tokens_reasoning?: number;
  total_native_tokens_cached?: number;
};

type OpenRouterModel = {
  id: string;
  canonical_slug?: string | null;
};

let cachedRanks:
  | { expiresAt: number; ranks: Map<string, number> }
  | undefined;

let refresh: Promise<Map<string, number>> | undefined;

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function withoutDateSuffix(slug: string): string {
  return slug.replace(/-\d{8}$/u, "");
}

function addRankAlias(ranks: Map<string, number>, slug: string, rank: number): void {
  const normalized = normalizeSlug(slug);
  const aliases = new Set([normalized, withoutDateSuffix(normalized)]);
  for (const alias of aliases) {
    const existing = ranks.get(alias);
    if (existing === undefined || rank < existing) ranks.set(alias, rank);
  }
}

function rowTokens(row: RankingRow): number {
  return (
    (row.total_prompt_tokens ?? 0) +
    (row.total_completion_tokens ?? 0) +
    (row.total_native_tokens_reasoning ?? 0) +
    (row.total_native_tokens_cached ?? 0)
  );
}

async function fetchRankingsActionId(signal: AbortSignal): Promise<string> {
  try {
    const htmlResponse = await fetch(RANKINGS_URL, {
      signal,
      headers: { "user-agent": "Mozilla/5.0" },
    });
    if (!htmlResponse.ok) throw new Error(`HTTP ${htmlResponse.status}`);
    const html = await htmlResponse.text();
    const chunkUrls = Array.from(
      new Set(
        [...html.matchAll(/src="([^"]+\.js\?dpl=[^"]+)"/g)].map(
          (match) => match[1],
        ),
      ),
    );
    for (const chunkUrl of chunkUrls) {
      const url = new URL(chunkUrl, RANKINGS_URL).toString();
      const chunkResponse = await fetch(url, {
        signal,
        headers: { "user-agent": "Mozilla/5.0" },
      });
      if (!chunkResponse.ok) continue;
      const chunk = await chunkResponse.text();
      const match = chunk.match(
        /createServerReference\("([a-f0-9]+)"[^)]*"getModelRankingsCached"\)/u,
      );
      if (match?.[1]) return match[1];
    }
  } catch {
    // Fall back to the last known action id. OpenRouter may rotate it on deploy.
  }
  return FALLBACK_MODEL_RANKINGS_ACTION_ID;
}

async function fetchWeeklyRankingRows(signal: AbortSignal): Promise<RankingRow[]> {
  const actionId = await fetchRankingsActionId(signal);
  const response = await fetch(RANKINGS_URL, {
    signal,
    method: "POST",
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      "next-action": actionId,
      "user-agent": "Mozilla/5.0",
    },
    body: JSON.stringify(["week"]),
  });
  if (!response.ok) throw new Error(`OpenRouter rankings HTTP ${response.status}`);
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("1:"));
  if (!dataLine) throw new Error("OpenRouter rankings response missing data");
  const rows = JSON.parse(dataLine.slice(2)) as unknown;
  return Array.isArray(rows) ? (rows as RankingRow[]) : [];
}

async function fetchOpenRouterModels(signal: AbortSignal): Promise<OpenRouterModel[]> {
  const response = await fetch(MODELS_URL, {
    signal,
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!response.ok) throw new Error(`OpenRouter models HTTP ${response.status}`);
  const body = (await response.json()) as { data?: OpenRouterModel[] };
  return Array.isArray(body.data) ? body.data : [];
}

async function buildPopularityRanks(signal: AbortSignal): Promise<Map<string, number>> {
  const [rows, models] = await Promise.all([
    fetchWeeklyRankingRows(signal),
    fetchOpenRouterModels(signal).catch(() => []),
  ]);

  const totals = new Map<string, number>();
  for (const row of rows) {
    const slug = row.variant_permaslug || row.model_permaslug;
    if (!slug || slug.toLowerCase() === "others") continue;
    totals.set(slug, (totals.get(slug) ?? 0) + rowTokens(row));
  }

  const rankedSlugs = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([slug]) => slug);

  const ranks = new Map<string, number>();
  rankedSlugs.forEach((slug, rank) => addRankAlias(ranks, slug, rank));

  for (const model of models) {
    const rank = [model.id, model.canonical_slug]
      .filter((slug): slug is string => Boolean(slug))
      .map((slug) => ranks.get(normalizeSlug(slug)))
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b)[0];
    if (rank !== undefined) addRankAlias(ranks, model.id, rank);
  }

  return ranks;
}

/** Optional ranking data never sits on the command/polling critical path. */
export function getCachedOpenRouterPopularityRanks(): Map<string, number> | undefined {
  if (!cachedRanks || cachedRanks.expiresAt <= Date.now()) void getOpenRouterPopularityRanks();
  return cachedRanks?.ranks;
}

export async function getOpenRouterPopularityRanks(): Promise<Map<string, number>> {
  if (cachedRanks && cachedRanks.expiresAt > Date.now()) return cachedRanks.ranks;
  refresh ??= buildPopularityRanks(AbortSignal.timeout(2000))
    .then((ranks) => {
      cachedRanks = { ranks, expiresAt: Date.now() + CACHE_TTL_MS };
      return ranks;
    })
    .catch(() => {
      const ranks = cachedRanks?.ranks ?? new Map<string, number>();
      cachedRanks = { ranks, expiresAt: Date.now() + 60_000 };
      return ranks;
    })
    .finally(() => { refresh = undefined; });
  return refresh;
}
