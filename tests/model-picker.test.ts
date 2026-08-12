import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { TelegramApi } from "../src/telegram/api";
import { TelegramModelPicker } from "../src/telegram/model-picker";
import type { TelegramCallbackQuery } from "../src/telegram/types";

const MODELS = [
  { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
  { provider: "openai", id: "gpt-5", name: "GPT-5" },
];

function token(provider: string, id: string): string {
  return createHash("sha256")
    .update(`${provider}/${id}`)
    .digest("hex")
    .slice(0, 12);
}

function pickerHarness(): {
  picker: TelegramModelPicker;
  selected: string[];
} {
  const selected: string[] = [];
  const api = {
    sendMessage: async () => ({ message_id: 1 }),
    sendTextReply: async () => 1,
    editMessageText: async () => undefined,
    answerCallbackQuery: async () => undefined,
  } as unknown as TelegramApi;
  const session = {
    isStreaming: false,
    model: MODELS[0],
    modelRuntime: { getAvailable: async () => MODELS },
    setModel: async (model: { provider: string; id: string }) => {
      selected.push(`${model.provider}/${model.id}`);
    },
  } as unknown as AgentSession;
  return { picker: new TelegramModelPicker(api, () => session), selected };
}

function setCallback(id: string): TelegramCallbackQuery {
  return {
    id: "cb-1",
    from: { id: 5, is_bot: false, first_name: "E" },
    message: { message_id: 2, chat: { id: 7, type: "private" } },
    data: `model:set:${id}`,
  };
}

const originalFetch = globalThis.fetch;

describe("Telegram model picker", () => {
  beforeEach(() => {
    // Keep the OpenRouter ranking lookup offline so ordering stays local.
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("selects the tapped model regardless of the active search filter", async () => {
    const { picker, selected } = pickerHarness();

    // A search narrows the list, so an index-based button would resolve to the
    // wrong entry when an older, unfiltered keyboard is tapped.
    await picker.showFiltered(7, 2, "gpt");
    await picker.handleCallbackQuery(
      setCallback(token("anthropic", "claude-opus-5")),
    );

    expect(selected).toEqual(["anthropic/claude-opus-5"]);
  });

  test("reports a model that is no longer available", async () => {
    const { picker, selected } = pickerHarness();

    await picker.handleCallbackQuery(setCallback(token("openai", "gone")));

    expect(selected).toEqual([]);
  });
});
