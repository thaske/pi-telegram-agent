import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { TelegramBridge } from "../src/bridge";
import { agentHarness, pendingTurn, waitUntil } from "./helpers/durable";
import { telegramApiHarness } from "./helpers/telegram";

test("/new commits its request receipt and selected conversation together across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-new-receipt-"));
  const database = join(dir, "state.sqlite");
  const harness = agentHarness();
  let agent = await harness.open(await openNodeSqliteStorage(database));
  try {
    await agent.newSession("telegram:10:5");
    const selected = agent.conversationId;
    await agent.close();
    agent = await harness.open(await openNodeSqliteStorage(database));
    await agent.newSession("telegram:10:5");
    expect(agent.conversationId).toBe(selected);
    expect(await agent.state.command("telegram:10:5")).toEqual({ kind: "new", conversationId: selected });
  } finally { await agent.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an acknowledged Stop before submission admission prevents the input from starting", async () => {
  const harness = agentHarness([fauxAssistantMessage("must not run")]);
  const agent = await harness.open(new MemoryStorage());
  const gate = Promise.withResolvers<void>();
  const wasStopped = agent.state.wasStopped.bind(agent.state);
  let checking = false;
  agent.state.wasStopped = async (id) => { checking = true; await gate.promise; return wasStopped(id); };
  try {
    const first = pendingTurn("first");
    await agent.enqueueTurn(first);
    await agent.enqueueTurn(pendingTurn("second"));
    const running = agent.runTurn(first);
    await waitUntil(() => checking);
    await agent.abort("telegram:10:stop");
    gate.resolve();
    expect((await running).aborted).toBe(true);
    expect(harness.faux.state.callCount).toBe(0);
    expect(await agent.state.wasStopped("second")).toBe(false);
  } finally { gate.resolve(); await agent.close(); }
});

test("a redelivered Stop after SQLite reopen cannot abort the next turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-stop-receipt-"));
  const database = join(dir, "state.sqlite");
  let firstStarted = false, secondStarted = false;
  const gate = Promise.withResolvers<void>();
  const harness = agentHarness([
    async (_messages, options) => {
      firstStarted = true;
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return fauxAssistantMessage("", { stopReason: "aborted" });
    },
    async () => { secondStarted = true; await gate.promise; return fauxAssistantMessage("second completed"); },
  ]);
  let agent = await harness.open(await openNodeSqliteStorage(database));
  try {
    const first = pendingTurn("first");
    await agent.enqueueTurn(first);
    await agent.enqueueTurn(pendingTurn("second"));
    const running = agent.runTurn(first);
    await waitUntil(() => firstStarted);
    await agent.abort("telegram:10:stop");
    expect((await running).aborted).toBe(true);
    await agent.state.complete("first");
    await agent.close();
    agent = await harness.open(await openNodeSqliteStorage(database));
    const next = agent.runTurn((await agent.state.pendingTurns())[0]);
    await waitUntil(() => secondStarted);
    await agent.abort("telegram:10:stop");
    expect(agent.isStreaming).toBe(true);
    gate.resolve();
    expect((await next).text).toBe("second completed");
  } finally { gate.resolve(); await agent.close(); await rm(dir, { recursive: true, force: true }); }
});

test("compaction resumes its original task and queues its completion reply after reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-compact-receipt-"));
  const database = join(dir, "state.sqlite");
  let summarizing = false;
  const harness = agentHarness([
    fauxAssistantMessage("first ".repeat(100)), fauxAssistantMessage("second ".repeat(100)),
    async (_messages, options) => {
      summarizing = true;
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return fauxAssistantMessage("", { stopReason: "aborted" });
    },
    fauxAssistantMessage("Compacted history."),
  ]);
  const settings = { compaction: { enabled: false, keepRecentTokens: 10, reserveTokens: 100 } };
  let agent = await harness.open(await openNodeSqliteStorage(database), settings);
  let bridge: TelegramBridge | undefined;
  try {
    for (const id of ["first", "second"]) {
      const turn = pendingTurn(id);
      await agent.enqueueTurn(turn);
      await agent.runTurn(turn);
      await agent.state.complete(id);
    }
    const id = await agent.startCompaction("telegram:10:5", { chatId: 10, replyToMessageId: 5 });
    await waitUntil(() => summarizing);
    await agent.close();
    agent = await harness.open(await openNodeSqliteStorage(database), settings);
    expect(await agent.startCompaction("telegram:10:5", { chatId: 10, replyToMessageId: 5 })).toBe(id);
    bridge = new TelegramBridge({}, async () => {}, agent);
    const telegram = telegramApiHarness();
    bridge.api.call = telegram.api.call.bind(telegram.api);
    await bridge.restorePendingTurns();
    await waitUntil(() => [...telegram.messages.values()].includes("Compaction completed."));
    expect(harness.faux.state.callCount).toBe(4);
    expect(await agent.state.pendingCompactions()).toEqual([]);
    expect(await agent.state.queueCompactionReply("telegram:10:5", "duplicate")).toBeUndefined();
  } finally { await bridge?.shutdown(); await agent.close(); await rm(dir, { recursive: true, force: true }); }
});
