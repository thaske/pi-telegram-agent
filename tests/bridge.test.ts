import { expect, test } from "bun:test";

import { goalCommandResponse, piGoalCommandText } from "../src/bridge";
import type { TelegramMessage } from "../src/telegram/types";

function textMessage(text: string): TelegramMessage {
  return { message_id: 1, chat: { id: 1, type: "private" }, text };
}

test("routes Telegram /goal commands through Pi's extension command handler", () => {
  expect(piGoalCommandText([textMessage("/goal status")])).toBe("/goal status");
  expect(piGoalCommandText([textMessage("/GOAL clear")])).toBe("/GOAL clear");
  expect(piGoalCommandText([textMessage("/goals")])).toBeUndefined();
  expect(piGoalCommandText([textMessage("please /goal status")])).toBeUndefined();
});

test("shows goal help for a bare Telegram /goal command", () => {
  const response = goalCommandResponse("/goal", "Usage: /goal [--tokens 50k] <objective>");

  expect(response).toContain("/goal pause");
  expect(response).toContain("/goal resume");
  expect(response).toContain("/goal clear");
  expect(response).toContain("/goal status");
  expect(goalCommandResponse("/goal clear", "No goal is set.")).toBe("No goal is set.");
});
