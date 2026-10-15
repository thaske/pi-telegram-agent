import { rejects } from "node:assert/strict";

import { describe, expect, test } from "bun:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";

import type { DurableTelegramAgent } from "../src/pi/durable-agent";
import { TelegramCommandHandler } from "../src/telegram/commands";
import { TelegramModelPicker } from "../src/telegram/model-picker";
import type { PendingTelegramTurn, TelegramMessage } from "../src/telegram/types";
import { agentHarness, pendingTurn, waitUntil } from "./helpers/durable";
import { telegramApiHarness } from "./helpers/telegram";

const message = (id: number, text: string): TelegramMessage => ({
  message_id: id, chat: { id: 10, type: "private" }, text,
});

function commandHarness(agent: DurableTelegramAgent, pending = false) {
  const telegram = telegramApiHarness();
  const queued: PendingTelegramTurn[] = [];
  const errors: unknown[] = [];
  const handler = new TelegramCommandHandler(telegram.api, new TelegramModelPicker(telegram.api, () => agent), {
    discardPreview: () => {}, hasPendingTurn: () => pending, getSession: () => agent,
    newSession: (requestId) => agent.newSession(requestId), onIdle: () => {},
    onReplyQueued: (turn) => queued.push(turn), onError: (error) => errors.push(error),
  });
  return { ...telegram, handler, queued, errors };
}

describe("durable Telegram commands", () => {
  test("does not allow /new to discard a turn awaiting delivery", async () => {
    const agent = await agentHarness().open(new MemoryStorage());
    const { handler, messages } = commandHarness(agent, true);
    try {
      const before = agent.conversationId;
      expect(await handler.handle([message(5, "/new")])).toBe(true);
      expect([...messages.values()]).toEqual([
        "Cannot start a new chat while the previous response is still being delivered. Try again shortly.",
      ]);
      expect(agent.conversationId).toBe(before);
    } finally { handler.shutdown(); await agent.close(); }
  });

  test("a failed /new notification does not repeat the committed conversation change", async () => {
    const agent = await agentHarness().open(new MemoryStorage());
    const { handler, failedSends } = commandHarness(agent);
    try {
      failedSends.add(1);
      await rejects(handler.handle([message(5, "/new")]), /Temporary failure/);
      const selected = agent.conversationId;
      failedSends.clear();
      await handler.handle([message(5, "/new")]);
      expect(agent.conversationId).toBe(selected);
      expect(await agent.state.command("telegram:10:5")).toEqual({ kind: "new", conversationId: selected });
    } finally { handler.shutdown(); await agent.close(); }
  });

  test("compaction returns to polling, Stop cancels it, and queued inputs remain queued", async () => {
    let started = false;
    const harness = agentHarness([
      fauxAssistantMessage("first ".repeat(100)),
      fauxAssistantMessage("second ".repeat(100)),
      async (_messages, options) => {
        started = true;
        await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    ]);
    const agent = await harness.open(new MemoryStorage(), {
      compaction: { enabled: false, keepRecentTokens: 10, reserveTokens: 100 },
    });
    const { handler, queued, errors } = commandHarness(agent);
    try {
      for (const id of ["first", "second"]) {
        const turn = pendingTurn(id);
        await agent.enqueueTurn(turn);
        await agent.runTurn(turn);
        await agent.state.complete(id);
      }
      await handler.handle([message(5, "/compact")]);
      await waitUntil(() => started);
      expect(handler.isBusy).toBe(true);
      const later = pendingTurn("later");
      await agent.enqueueTurn(later);
      await handler.handle([message(6, "/stop")]);
      await waitUntil(() => queued.length === 1 && !handler.isBusy);
      expect(queued[0]?.completedResponse?.text).toContain("Compaction failed:");
      expect((await agent.state.pendingTurns())[0]?.id).toBe("later");
      expect(await agent.state.wasStopped("later")).toBe(false);
      expect(errors).toEqual([]);
    } finally { handler.shutdown(); await agent.close(); }
  });

  test("shutdown does not wait for a pending compaction observer", async () => {
    const agent = await agentHarness().open(new MemoryStorage());
    const { handler, queued } = commandHarness(agent);
    const gate = Promise.withResolvers<void>();
    agent.waitForCompaction = async () => gate.promise;
    try {
      await handler.handle([message(5, "/compact")]);
      expect(handler.isBusy).toBe(true);
      handler.shutdown();
      gate.resolve();
      await waitUntil(() => !handler.isBusy);
      expect(queued).toEqual([]);
    } finally { handler.shutdown(); gate.resolve(); await agent.close(); }
  });
});
