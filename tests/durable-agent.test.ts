import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { awaitWithContext } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";

import { createTelegramAttachTool } from "../src/pi/telegram-attach-tool";
import { agentHarness, pendingTurn, waitUntil } from "./helpers/durable";

describe("durable Telegram agent", () => {
  test("deduplicates admitted inputs and completed Telegram updates", async () => {
    const harness = agentHarness([fauxAssistantMessage("answer")]);
    const agent = await harness.open(new MemoryStorage());
    try {
      const turn = pendingTurn();
      expect(await agent.enqueueTurn(turn)).toBe(true);
      expect(await agent.enqueueTurn(pendingTurn())).toBe(false);
      expect((await agent.runTurn(turn)).text).toBe("answer");
      expect((await agent.runTurn(turn)).text).toBe("answer");
      expect(harness.faux.state.callCount).toBe(1);
      expect((await agent.getStatus()).totalMessages).toBe(2);
      await agent.state.complete(turn.id);
      expect(await agent.enqueueTurn(pendingTurn())).toBe(false);
      expect(await agent.state.pendingTurns()).toEqual([]);
    } finally {
      await agent.close();
    }
  });

  test("SQLite reopen resumes a tool round without repeating completed calls or the user input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-durable-"));
    let finished = 0;
    let paused = 0;
    const gate = Promise.withResolvers<void>();
    let resume = false;
    const extension = defineExtension({
      name: "checkpoint-test",
      tools: [
        defineTool({
          name: "finished",
          parameters: Type.Object({}),
          description: "A completed call",
          replay: "safe",
          execute: async () => {
            finished += 1;
            return { output: [{ type: "text", text: "done" }] };
          },
        }),
        defineTool({
          name: "pause",
          parameters: Type.Object({}),
          description: "A replay-safe interrupted call",
          replay: "safe",
          execute: async (_args, _api, context) => {
            paused += 1;
            if (!resume) await awaitWithContext(gate.promise, context);
            return { output: [{ type: "text", text: "resumed" }] };
          },
        }),
      ],
    });
    const harness = agentHarness([
      fauxAssistantMessage([fauxToolCall("finished", {}), fauxToolCall("pause", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("after restart"),
    ], [extension]);
    const database = join(dir, "state.sqlite");
    let agent = await harness.open(await openNodeSqliteStorage(database));
    try {
      const turn = pendingTurn();
      await agent.enqueueTurn(turn);
      let finishedCommitted = false;
      agent.subscribe((event) => {
        if (event.type === "tool_execution_end" && event.toolName === "finished") finishedCommitted = true;
      });
      const interrupted = agent.runTurn(turn).catch(() => undefined);
      await waitUntil(() => paused === 1 && finishedCommitted);
      const conversationId = agent.conversationId;
      await agent.close();
      await interrupted;

      resume = true;
      agent = await harness.open(await openNodeSqliteStorage(database));
      expect(agent.conversationId).toBe(conversationId);
      const restored = (await agent.state.pendingTurns())[0];
      const result = await agent.runTurn(restored);
      expect(result.text).toBe("after restart");
      expect(finished).toBe(1);
      expect(paused).toBe(2);
      expect(harness.faux.state.callCount).toBe(2);
      expect((await agent.getStatus()).totalMessages).toBe(5);
    } finally {
      await agent.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

});

describe("durable attachments and lifecycle", () => {
  test("attachment intents survive replay and resolve relative paths against the agent cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-attachment-"));
    const path = join(dir, "artifact.txt");
    await writeFile(path, "artifact");
    const gate = Promise.withResolvers<void>();
    let resume = false;
    const attach = createTelegramAttachTool();
    const extension = defineExtension({
      name: "replayed-attachment",
      tools: [defineTool({
        ...attach,
        execute: async (args, api, context) => {
          const result = await attach.execute(args, api, context);
          if (!resume) await awaitWithContext(gate.promise, context);
          return result;
        },
      })],
    });
    const harness = agentHarness([
      fauxAssistantMessage(fauxToolCall("telegram_attach", { paths: ["artifact.txt"] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("attached"),
    ], [extension], dir);
    const database = join(dir, "state.sqlite");
    let agent = await harness.open(await openNodeSqliteStorage(database));
    try {
      const turn = pendingTurn();
      await agent.enqueueTurn(turn);
      const interrupted = agent.runTurn(turn).catch(() => undefined);
      await waitUntil(async () => (await agent.state.pendingTurns())[0]?.queuedAttachments.length === 1);
      await agent.close();
      await interrupted;
      resume = true;
      agent = await harness.open(await openNodeSqliteStorage(database));
      const result = await agent.runTurn((await agent.state.pendingTurns())[0]);
      expect(result.text).toBe("attached");
      expect(result.queuedAttachments).toEqual([{ path, fileName: "artifact.txt" }]);
    } finally {
      await agent.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("new chat selection and model choices survive reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-new-chat-"));
    const harness = agentHarness([fauxAssistantMessage("first answer")]);
    const database = join(dir, "state.sqlite");
    let agent = await harness.open(await openNodeSqliteStorage(database));
    try {
      const turn = pendingTurn();
      await agent.enqueueTurn(turn);
      await agent.runTurn(turn);
      await agent.state.complete(turn.id);
      const previous = agent.conversationId;
      await agent.setModel(harness.faux.getModel());
      await agent.newSession();
      const current = agent.conversationId;
      expect(current).not.toBe(previous);
      expect((await agent.getStatus()).totalMessages).toBe(0);
      await agent.close();
      agent = await harness.open(await openNodeSqliteStorage(database));
      expect(agent.conversationId).toBe(current);
      expect(agent.model?.id).toBe(harness.faux.getModel().id);
    } finally {
      await agent.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("abort settles the current input without dropping queued Telegram turns", async () => {
    let started = false;
    const harness = agentHarness([async (_messages, options) => {
      started = true;
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }]);
    const agent = await harness.open(new MemoryStorage());
    try {
      const turn = pendingTurn();
      await agent.enqueueTurn(turn);
      await agent.enqueueTurn(pendingTurn("turn-2"));
      const running = agent.runTurn(turn);
      await waitUntil(() => started);
      await agent.abort();
      expect((await running).aborted).toBe(true);
      expect((await agent.state.pendingTurns()).map((pending) => pending.id)).toEqual(["turn-1", "turn-2"]);
    } finally {
      await agent.close();
    }
  });
});
