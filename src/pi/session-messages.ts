import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { MessageChange } from "@earendil-works/pi-durable";

export function getMessageText(message: Message): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/** Reconstruct the committed partial from pi-durable's incremental message events. */
export function applyMessageChanges(
  message: AssistantMessage | undefined,
  changes: readonly MessageChange[],
): AssistantMessage | undefined {
  for (const change of changes) {
    if (change.type === "message") {
      message = structuredClone(change.message);
    } else if (message && "block" in change) {
      message.content[change.contentIndex] = structuredClone(change.block);
    } else if (message && (change.type === "text_delta" || change.type === "thinking_delta")) {
      const block = message.content[change.contentIndex];
      if (block?.type === "text" && change.type === "text_delta") block.text += change.delta;
      if (block?.type === "thinking" && change.type === "thinking_delta") block.thinking += change.delta;
    }
  }
  return message;
}
