import type { TelegramMessage } from "./types";

export function telegramMessageKey(message: TelegramMessage): string {
  return `telegram:${message.chat.id}:${message.message_id}`;
}

export function telegramTurnId(messages: TelegramMessage[]): string {
  const first = messages[0];
  if (!first) throw new Error("Missing Telegram message");
  return `telegram:${first.chat.id}:${messages.map((message) => message.message_id).sort((a, b) => a - b).join(",")}`;
}

/** Also recovers individual receipts from turn IDs written by older versions. */
export function turnMessageKeys(turnId: string): string[] {
  const match = /^telegram:(-?\d+):(\d+(?:,\d+)*)$/.exec(turnId);
  return match ? match[2].split(",").map((id) => `telegram:${match[1]}:${id}`) : [];
}
