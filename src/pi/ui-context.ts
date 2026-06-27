import { log } from "../logger";
import type { TelegramProgressManager } from "../telegram/progress";

export function createTelegramUiContext(
  progress: TelegramProgressManager,
  hasActiveTelegramTurn: () => boolean,
) {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message: string, type?: string) => {
      log(`notify:${type ?? "info"}: ${message}`);
      if (hasActiveTelegramTurn())
        progress.setStatus(`notify:${type ?? "info"}`, message);
    },
    onTerminalInput: () => () => undefined,
    setStatus: (key: string, text?: string) => progress.setStatus(key, text),
    setWorkingMessage: (message?: string) =>
      progress.setWorkingMessage(message),
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: (label?: string) =>
      progress.setHiddenThinkingLabel(label),
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: async <T>() => undefined as T,
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    get theme() {
      return {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        dim: (text: string) => text,
        italic: (text: string) => text,
        underline: (text: string) => text,
      } as never;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "not supported" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  };
}
