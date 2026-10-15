import { expect, test } from "bun:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";

import { getMessageText } from "../src/pi/session-messages";
import { agentHarness, pendingTurn } from "./helpers/durable";

test("manual compaction waits for its summary to be applied", async () => {
  const harness = agentHarness([
    fauxAssistantMessage("first response ".repeat(100)),
    fauxAssistantMessage("second response ".repeat(100)),
    fauxAssistantMessage("Compacted history."),
  ]);
  const agent = await harness.open(new MemoryStorage(), {
    compaction: { enabled: false, keepRecentTokens: 10, reserveTokens: 100 },
  });
  try {
    for (const id of ["first", "second"]) {
      const turn = pendingTurn(id);
      await agent.enqueueTurn(turn);
      await agent.runTurn(turn);
      await agent.state.complete(id);
    }
    await agent.compact();
    const conversation = await agent.harness.conversation(agent.conversationId, BACKGROUND_CONTEXT);
    const context = await conversation?.context(BACKGROUND_CONTEXT);
    expect(context?.entries.some((entry) => entry.kind === "pi.compaction")).toBe(true);
    expect(context?.messages.map(getMessageText).join("\n")).toContain("Compacted history.");
    expect(agent.isStreaming).toBe(false);
    expect(harness.faux.state.callCount).toBe(3);
  } finally {
    await agent.close();
  }
});

test("failed model submissions remain idempotent and expose their error", async () => {
  const harness = agentHarness([fauxAssistantMessage("", { stopReason: "error", errorMessage: "model failed" })]);
  const agent = await harness.open(new MemoryStorage());
  try {
    const turn = pendingTurn();
    await agent.enqueueTurn(turn);
    expect((await agent.runTurn(turn)).error).toBe("model failed");
    expect((await agent.runTurn(turn)).error).toBe("model failed");
    expect(harness.faux.state.callCount).toBe(1);
  } finally {
    await agent.close();
  }
});
