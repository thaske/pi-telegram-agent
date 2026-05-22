import type { AgentMessage } from "@earendil-works/pi-agent-core";

export function isAssistantMessage(message: AgentMessage): boolean {
  return (message as unknown as { role?: string }).role === "assistant";
}

export function getMessageText(message: AgentMessage): string {
  const content = (message as unknown as { content?: unknown[] }).content ?? [];
  return content
    .filter(
      (b): b is { type: string; text?: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text",
    )
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

export function extractAssistantText(messages: AgentMessage[]): {
  text?: string;
  stopReason?: string;
  errorMessage?: string;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as unknown as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    };
    if (m.role !== "assistant") continue;
    return {
      text: getMessageText(messages[i]),
      stopReason: m.stopReason,
      errorMessage: m.errorMessage,
    };
  }
  return {};
}
