import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  defineTool,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface TelegramConfig {
  botToken?: string;
  botUsername?: string;
  botId?: number;
  allowedUserId?: number;
  lastUpdateId?: number;
}

interface TelegramApiResponse<T> { ok: boolean; result?: T; description?: string; error_code?: number }
interface TelegramUser { id: number; is_bot: boolean; first_name: string; username?: string }
interface TelegramChat { id: number; type: string }
interface TelegramPhotoSize { file_id: string; file_size?: number }
interface TelegramDocument { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
interface TelegramVideo { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
interface TelegramAudio { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
interface TelegramVoice { file_id: string; mime_type?: string; file_size?: number }
interface TelegramAnimation { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
interface TelegramSticker { file_id: string; emoji?: string }
interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  animation?: TelegramAnimation;
  sticker?: TelegramSticker;
}
interface TelegramUpdate { update_id: number; message?: TelegramMessage; edited_message?: TelegramMessage }
interface TelegramGetFileResult { file_path: string }
interface TelegramSentMessage { message_id: number }
interface TelegramFileInfo { file_id: string; fileName: string; mimeType?: string; isImage: boolean }
interface DownloadedTelegramFile { path: string; fileName: string; isImage: boolean; mimeType?: string }
interface QueuedAttachment { path: string; fileName: string }
interface PendingTelegramTurn {
  chatId: number;
  replyToMessageId: number;
  queuedAttachments: QueuedAttachment[];
  content: Array<TextContent | ImageContent>;
  historyText: string;
}
interface TelegramPreviewState {
  mode: "draft" | "message";
  draftId?: number;
  messageId?: number;
  pendingText: string;
  lastSentText: string;
  flushTimer?: ReturnType<typeof setTimeout>;
}
interface TelegramMediaGroupState { messages: TelegramMessage[]; flushTimer?: ReturnType<typeof setTimeout> }

const CONFIG_PATH = process.env.PI_TELEGRAM_CONFIG ?? join(homedir(), ".pi", "agent", "telegram.json");
const TEMP_DIR = process.env.PI_TELEGRAM_TMP ?? join(homedir(), ".pi", "agent", "tmp", "telegram-agent");
const CWD = process.env.PI_TELEGRAM_CWD ?? process.cwd();
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 750;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;

let config: TelegramConfig = {};
let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
let session: AgentSession;
let unsubscribe: (() => void) | undefined;
let pollingController: AbortController | undefined;
let queuedTelegramTurns: PendingTelegramTurn[] = [];
let activeTelegramTurn: PendingTelegramTurn | undefined;
let typingInterval: ReturnType<typeof setInterval> | undefined;
let previewState: TelegramPreviewState | undefined;
let draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
let nextDraftId = 0;
let preserveQueuedTurnsAsHistory = false;
const mediaGroups = new Map<string, TelegramMediaGroupState>();

function log(message: string): void { console.log(`[${new Date().toISOString()}] ${message}`); }
function allocateDraftId(): number { nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1; return nextDraftId; }
async function readConfig(): Promise<TelegramConfig> { try { return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as TelegramConfig; } catch { return {}; } }
async function writeConfig(next: TelegramConfig): Promise<void> { await mkdir(join(homedir(), ".pi", "agent"), { recursive: true }); await writeFile(CONFIG_PATH, JSON.stringify(next, null, "\t") + "\n", "utf8"); }
function sanitizeFileName(name: string): string { return name.replace(/[^a-zA-Z0-9._-]+/g, "_"); }
function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string { if (!mimeType) return fallback; const ext = mimeType.split("/").pop(); return ext ? `.${ext.replace(/[^a-zA-Z0-9]/g, "")}` : fallback; }
function guessMediaType(path: string): string | undefined { const ext = path.toLowerCase().split(".").pop(); if (!ext) return undefined; if (["jpg", "jpeg"].includes(ext)) return "image/jpeg"; if (ext === "png") return "image/png"; if (ext === "gif") return "image/gif"; if (ext === "webp") return "image/webp"; return undefined; }

function chunkParagraphs(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = ""; };
  for (const paragraph of text.split(/\n\n+/)) {
    const parts = paragraph.match(new RegExp(`[\\s\\S]{1,${MAX_MESSAGE_LENGTH - 32}}`, "g")) ?? [];
    for (const part of parts) {
      const candidate = current ? `${current}\n\n${part}` : part;
      if (candidate.length <= MAX_MESSAGE_LENGTH) current = candidate;
      else { flush(); current = part; }
    }
  }
  flush();
  return chunks.length ? chunks : [""];
}

async function callTelegram<TResponse>(method: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<TResponse> {
  if (!config.botToken) throw new Error("Telegram bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: options?.signal,
  });
  const data = (await response.json()) as TelegramApiResponse<TResponse>;
  if (!data.ok || data.result === undefined) throw new Error(data.description || `Telegram API ${method} failed`);
  return data.result;
}
async function callTelegramMultipart<TResponse>(method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string, options?: { signal?: AbortSignal }): Promise<TResponse> {
  if (!config.botToken) throw new Error("Telegram bot token is not configured");
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set(fileField, new Blob([await readFile(filePath)]), fileName);
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, { method: "POST", body: form, signal: options?.signal });
  const data = (await response.json()) as TelegramApiResponse<TResponse>;
  if (!data.ok || data.result === undefined) throw new Error(data.description || `Telegram API ${method} failed`);
  return data.result;
}
async function configureTelegramCommands(signal?: AbortSignal): Promise<void> {
  await callTelegram<boolean>("setMyCommands", { commands: [
    { command: "new", description: "Start a new Pi chat" },
    { command: "status", description: "Show model, usage, and context" },
    { command: "compact", description: "Compact the current Pi chat" },
    { command: "stop", description: "Abort the active Pi turn" },
    { command: "help", description: "Show Telegram bridge help" },
  ] }, { signal });
}
async function downloadTelegramFile(fileId: string, suggestedName: string): Promise<string> {
  if (!config.botToken) throw new Error("Telegram bot token is not configured");
  const file = await callTelegram<TelegramGetFileResult>("getFile", { file_id: fileId });
  await mkdir(TEMP_DIR, { recursive: true });
  const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
  const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
  if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
  await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
  return targetPath;
}
async function sendTextReply(chatId: number, _replyToMessageId: number, text: string): Promise<number | undefined> {
  let lastMessageId: number | undefined;
  for (const chunk of chunkParagraphs(text)) {
    const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: chunk });
    lastMessageId = sent.message_id;
  }
  return lastMessageId;
}
function startTypingLoop(chatId?: number): void {
  const targetChatId = chatId ?? activeTelegramTurn?.chatId;
  if (typingInterval || targetChatId === undefined) return;
  const sendTyping = async () => { try { await callTelegram("sendChatAction", { chat_id: targetChatId, action: "typing" }); } catch (e) { log(`typing failed: ${e instanceof Error ? e.message : String(e)}`); } };
  void sendTyping();
  typingInterval = setInterval(() => void sendTyping(), 4000);
}
function stopTypingLoop(): void { if (typingInterval) clearInterval(typingInterval); typingInterval = undefined; }

async function clearPreview(chatId: number): Promise<void> {
  const state = previewState; if (!state) return;
  if (state.flushTimer) clearTimeout(state.flushTimer);
  previewState = undefined;
  if (state.mode === "draft" && state.draftId !== undefined) {
    try { await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: state.draftId, text: "" }); } catch { /* ignore */ }
  }
}
async function flushPreview(chatId: number): Promise<void> {
  const state = previewState; if (!state) return;
  state.flushTimer = undefined;
  const text = state.pendingText.trim();
  if (!text || text === state.lastSentText) return;
  const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;
  if (draftSupport !== "unsupported") {
    const draftId = state.draftId ?? allocateDraftId(); state.draftId = draftId;
    try { await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: truncated }); draftSupport = "supported"; state.mode = "draft"; state.lastSentText = truncated; return; } catch { draftSupport = "unsupported"; }
  }
  if (state.messageId === undefined) {
    const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: truncated });
    state.messageId = sent.message_id; state.mode = "message"; state.lastSentText = truncated; return;
  }
  await callTelegram("editMessageText", { chat_id: chatId, message_id: state.messageId, text: truncated });
  state.mode = "message"; state.lastSentText = truncated;
}
function schedulePreviewFlush(chatId: number): void { if (!previewState || previewState.flushTimer) return; previewState.flushTimer = setTimeout(() => void flushPreview(chatId), PREVIEW_THROTTLE_MS); }
async function finalizePreview(chatId: number): Promise<boolean> {
  const state = previewState; if (!state) return false;
  await flushPreview(chatId);
  const finalText = (state.pendingText.trim() || state.lastSentText).trim();
  if (!finalText) { await clearPreview(chatId); return false; }
  if (state.mode === "draft") { await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: finalText }); await clearPreview(chatId); return true; }
  previewState = undefined; return state.messageId !== undefined;
}

function isAssistantMessage(message: AgentMessage): boolean { return (message as unknown as { role?: string }).role === "assistant"; }
function getMessageText(message: AgentMessage): string {
  const content = (message as unknown as { content?: unknown[] }).content ?? [];
  return content.filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
    .map((b) => b.text ?? "").join("").trim();
}
function extractAssistantText(messages: AgentMessage[]): { text?: string; stopReason?: string; errorMessage?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as unknown as { role?: string; stopReason?: string; errorMessage?: string };
    if (m.role !== "assistant") continue;
    return { text: getMessageText(messages[i]), stopReason: m.stopReason, errorMessage: m.errorMessage };
  }
  return {};
}

async function sendQueuedAttachments(turn: PendingTelegramTurn): Promise<void> {
  for (const attachment of turn.queuedAttachments) {
    try {
      const mediaType = guessMediaType(attachment.path);
      await callTelegramMultipart<TelegramSentMessage>(mediaType ? "sendPhoto" : "sendDocument", { chat_id: String(turn.chatId) }, mediaType ? "photo" : "document", attachment.path, attachment.fileName);
    } catch (error) {
      await sendTextReply(turn.chatId, turn.replyToMessageId, `Failed to send attachment ${attachment.fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function collectTelegramFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
  const files: TelegramFileInfo[] = [];
  for (const message of messages) {
    const photo = message.photo?.at(-1);
    if (photo) files.push({ file_id: photo.file_id, fileName: `photo-${message.message_id}.jpg`, mimeType: "image/jpeg", isImage: true });
    if (message.document) files.push({ file_id: message.document.file_id, fileName: message.document.file_name || `document-${message.message_id}`, mimeType: message.document.mime_type, isImage: !!message.document.mime_type?.startsWith("image/") });
    if (message.video) files.push({ file_id: message.video.file_id, fileName: message.video.file_name || `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`, mimeType: message.video.mime_type, isImage: false });
    if (message.audio) files.push({ file_id: message.audio.file_id, fileName: message.audio.file_name || `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`, mimeType: message.audio.mime_type, isImage: false });
    if (message.voice) files.push({ file_id: message.voice.file_id, fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`, mimeType: message.voice.mime_type, isImage: false });
    if (message.animation) files.push({ file_id: message.animation.file_id, fileName: message.animation.file_name || `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`, mimeType: message.animation.mime_type, isImage: false });
    if (message.sticker) files.push({ file_id: message.sticker.file_id, fileName: `sticker-${message.message_id}.webp`, mimeType: "image/webp", isImage: true });
  }
  return files;
}
async function buildTelegramFiles(messages: TelegramMessage[]): Promise<DownloadedTelegramFile[]> {
  const downloaded: DownloadedTelegramFile[] = [];
  for (const file of collectTelegramFileInfos(messages)) downloaded.push({ path: await downloadTelegramFile(file.file_id, file.fileName), fileName: file.fileName, isImage: file.isImage, mimeType: file.mimeType });
  return downloaded;
}
async function createTelegramTurn(messages: TelegramMessage[], historyTurns: PendingTelegramTurn[] = []): Promise<PendingTelegramTurn> {
  const firstMessage = messages[0]; if (!firstMessage) throw new Error("Missing Telegram message");
  const rawText = messages.map((m) => (m.text || m.caption || "").trim()).filter(Boolean).join("\n\n");
  const files = await buildTelegramFiles(messages);
  let prompt = `${TELEGRAM_PREFIX}`;
  if (historyTurns.length > 0) {
    prompt += "\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:";
    for (const [index, turn] of historyTurns.entries()) prompt += `\n\n${index + 1}. ${turn.historyText}`;
    prompt += "\n\nCurrent Telegram message:";
  }
  if (rawText) prompt += historyTurns.length > 0 ? `\n${rawText}` : ` ${rawText}`;
  if (files.length) prompt += "\n\nTelegram attachments were saved locally:" + files.map((f) => `\n- ${f.path}`).join("");
  const content: Array<TextContent | ImageContent> = [{ type: "text", text: prompt }];
  for (const file of files) {
    if (!file.isImage) continue;
    const mimeType = file.mimeType || guessMediaType(file.path);
    if (!mimeType) continue;
    content.push({ type: "image", mimeType, data: (await readFile(file.path)).toString("base64") });
  }
  const historyText = rawText || "(no text)" + (files.length ? `\nAttachments:${files.map((f) => `\n- ${f.path}`).join("")}` : "");
  return { chatId: firstMessage.chat.id, replyToMessageId: firstMessage.message_id, queuedAttachments: [], content, historyText };
}

async function startNextTurnIfIdle(): Promise<void> {
  if (session.isStreaming || activeTelegramTurn || queuedTelegramTurns.length === 0) return;
  const turn = queuedTelegramTurns.shift(); if (!turn) return;
  activeTelegramTurn = turn;
  previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
  startTypingLoop(turn.chatId);
  void session.sendUserMessage(turn.content).catch(async (error) => {
    stopTypingLoop(); activeTelegramTurn = undefined; await clearPreview(turn.chatId);
    await sendTextReply(turn.chatId, turn.replyToMessageId, error instanceof Error ? error.message : String(error));
    void startNextTurnIfIdle();
  });
}

async function dispatchAuthorizedTelegramMessages(messages: TelegramMessage[]): Promise<void> {
  const firstMessage = messages[0]; if (!firstMessage) return;
  const rawText = messages.map((m) => (m.text || m.caption || "").trim()).find(Boolean) || "";
  const lower = rawText.toLowerCase();
  if (lower === "stop" || lower === "/stop") {
    if (session.isStreaming) { if (queuedTelegramTurns.length) preserveQueuedTurnsAsHistory = true; await session.abort(); await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Aborted current turn."); }
    else await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "No active turn.");
    return;
  }
  if (lower === "/new" || lower === "new" || lower === "/reset") {
    if (session.isStreaming) { await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Cannot start a new chat while pi is busy. Send /stop first."); return; }
    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Starting a new Pi chat...");
    queuedTelegramTurns = []; activeTelegramTurn = undefined; previewState = undefined;
    const result = await runtime.newSession();
    if (!result.cancelled) await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "New Pi chat started.");
    await bindSession();
    return;
  }
  if (lower === "/compact") {
    if (session.isStreaming) { await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Cannot compact while pi is busy. Send /stop first."); return; }
    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction started.");
    try { await session.compact(); await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction completed."); }
    catch (e) { await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Compaction failed: ${e instanceof Error ? e.message : String(e)}`); }
    return;
  }
  if (lower === "/status") {
    const stats = session.getSessionStats(); const usage = session.getContextUsage();
    const lines = [`Model: ${session.model ? `${session.model.provider}/${session.model.id}` : "unknown"}`, `Messages: ${stats.totalMessages}`, `Cost: $${stats.cost.toFixed(3)}`];
    if (usage) lines.push(`Context: ${usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?"}/${usage.contextWindow ?? session.model?.contextWindow ?? "?"}`);
    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, lines.join("\n")); return;
  }
  if (lower === "/help" || lower === "/start") {
    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Send me a message and I will forward it to Pi. Commands: /new, /status, /compact, /stop, /help.");
    return;
  }
  const historyTurns = preserveQueuedTurnsAsHistory ? queuedTelegramTurns.splice(0) : [];
  preserveQueuedTurnsAsHistory = false;
  queuedTelegramTurns.push(await createTelegramTurn(messages, historyTurns));
  await startNextTurnIfIdle();
}
async function handleAuthorizedTelegramMessage(message: TelegramMessage): Promise<void> {
  if (message.media_group_id) {
    const key = `${message.chat.id}:${message.media_group_id}`;
    const existing = mediaGroups.get(key) ?? { messages: [] };
    existing.messages.push(message);
    if (existing.flushTimer) clearTimeout(existing.flushTimer);
    existing.flushTimer = setTimeout(() => { const state = mediaGroups.get(key); mediaGroups.delete(key); if (state) void dispatchAuthorizedTelegramMessages(state.messages); }, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
    mediaGroups.set(key, existing); return;
  }
  await dispatchAuthorizedTelegramMessages([message]);
}
async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message || update.edited_message;
  if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;
  if (config.allowedUserId === undefined) { config.allowedUserId = message.from.id; await writeConfig(config); await sendTextReply(message.chat.id, message.message_id, "Telegram bridge paired with this account."); }
  if (message.from.id !== config.allowedUserId) { await sendTextReply(message.chat.id, message.message_id, "This bot is not authorized for your account."); return; }
  await handleAuthorizedTelegramMessage(message);
}

async function pollLoop(signal: AbortSignal): Promise<void> {
  if (!config.botToken) throw new Error("Telegram bot token is not configured");
  await callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal }).catch(() => undefined);
  await configureTelegramCommands(signal);
  if (config.lastUpdateId === undefined) {
    const updates = await callTelegram<TelegramUpdate[]>("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal }).catch(() => []);
    const last = updates.at(-1); if (last) { config.lastUpdateId = last.update_id; await writeConfig(config); }
  }
  log("telegram polling started");
  while (!signal.aborted) {
    try {
      const updates = await callTelegram<TelegramUpdate[]>("getUpdates", { offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined, limit: 10, timeout: 30, allowed_updates: ["message", "edited_message"] }, { signal });
      for (const update of updates) { config.lastUpdateId = update.update_id; await writeConfig(config); await handleUpdate(update); }
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      log(`polling error: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

function onSessionEvent(event: AgentSessionEvent): void {
  const turn = activeTelegramTurn;
  if (event.type === "message_start" && turn && isAssistantMessage(event.message)) {
    if (previewState && (previewState.pendingText.trim() || previewState.lastSentText.trim())) void finalizePreview(turn.chatId);
    previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
  }
  if (event.type === "message_update" && turn && isAssistantMessage(event.message)) {
    previewState ??= { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
    previewState.pendingText = getMessageText(event.message);
    schedulePreviewFlush(turn.chatId);
  }
  if (event.type === "agent_end") {
    void (async () => {
      const doneTurn = activeTelegramTurn; stopTypingLoop(); activeTelegramTurn = undefined;
      if (!doneTurn) return;
      const assistant = extractAssistantText(event.messages);
      if (assistant.stopReason === "aborted") { await clearPreview(doneTurn.chatId); void startNextTurnIfIdle(); return; }
      if (assistant.stopReason === "error") { await clearPreview(doneTurn.chatId); await sendTextReply(doneTurn.chatId, doneTurn.replyToMessageId, assistant.errorMessage || "Pi failed while processing the request."); void startNextTurnIfIdle(); return; }
      const finalText = assistant.text;
      if (previewState) previewState.pendingText = finalText ?? previewState.pendingText;
      if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) await finalizePreview(doneTurn.chatId);
      else { await clearPreview(doneTurn.chatId); if (finalText) await sendTextReply(doneTurn.chatId, doneTurn.replyToMessageId, finalText); }
      await sendQueuedAttachments(doneTurn);
      void startNextTurnIfIdle();
    })();
  }
}

async function bindSession(): Promise<void> {
  unsubscribe?.();
  session = runtime.session;
  await session.bindExtensions({
    uiContext: {
      select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: (m, t) => log(`notify:${t ?? "info"}: ${m}`),
      onTerminalInput: () => () => undefined, setStatus: () => undefined, setWorkingMessage: () => undefined, setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined, setHiddenThinkingLabel: () => undefined, setWidget: () => undefined, setFooter: () => undefined, setHeader: () => undefined,
      setTitle: () => undefined, custom: async <T,>() => undefined as T, pasteToEditor: () => undefined, setEditorText: () => undefined, getEditorText: () => "",
      editor: async () => undefined, addAutocompleteProvider: () => undefined, setEditorComponent: () => undefined, getEditorComponent: () => undefined,
      get theme() { return {} as never; }, getAllThemes: () => [], getTheme: () => undefined, setTheme: () => ({ success: false, error: "not supported" }), getToolsExpanded: () => false, setToolsExpanded: () => undefined,
    },
    commandContextActions: {
      waitForIdle: () => session.agent.waitForIdle(), newSession: (options) => runtime.newSession(options), fork: async (entryId, options) => ({ cancelled: (await runtime.fork(entryId, options)).cancelled }),
      navigateTree: async (targetId, options) => ({ cancelled: (await session.navigateTree(targetId, options)).cancelled }), switchSession: (path, options) => runtime.switchSession(path, options), reload: () => session.reload(),
    },
    shutdownHandler: () => void shutdown(),
    onError: (e) => log(`extension error ${e.extensionPath} ${e.event}: ${e.error}`),
  });
  unsubscribe = session.subscribe(onSessionEvent);
}

const telegramAttachTool = defineTool({
  name: "telegram_attach",
  label: "Telegram Attach",
  description: "Queue one or more local files to be sent with the next Telegram reply.",
  promptSnippet: "Queue local files to be sent with the next Telegram reply.",
  promptGuidelines: ["When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text."],
  parameters: Type.Object({ paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }) }),
  async execute(_toolCallId, params) {
    if (!activeTelegramTurn) throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
    const added: string[] = [];
    for (const inputPath of params.paths) {
      const stats = await stat(inputPath); if (!stats.isFile()) throw new Error(`Not a file: ${inputPath}`);
      if (activeTelegramTurn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
      activeTelegramTurn.queuedAttachments.push({ path: inputPath, fileName: basename(inputPath) }); added.push(inputPath);
    }
    return { content: [{ type: "text" as const, text: `Queued ${added.length} Telegram attachment(s).` }], details: { paths: added } };
  },
});

async function main(): Promise<void> {
  config = await readConfig();
  if (!config.botToken) throw new Error(`No botToken in ${CONFIG_PATH}. Run /telegram-setup in Pi once or create this config.`);
  await mkdir(TEMP_DIR, { recursive: true });

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir });
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, customTools: [telegramAttachTool] })), services, diagnostics: services.diagnostics };
  };
  runtime = await createAgentSessionRuntime(createRuntime, { cwd: CWD, agentDir: getAgentDir(), sessionManager: SessionManager.create(CWD) });
  runtime.setRebindSession(async () => bindSession());
  await bindSession();
  log(`started; cwd=${CWD}; session=${session.sessionFile ?? session.sessionId}`);
  pollingController = new AbortController();
  void pollLoop(pollingController.signal).catch((e) => { log(`fatal polling error: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
}
async function shutdown(): Promise<void> {
  log("shutting down");
  pollingController?.abort(); stopTypingLoop(); unsubscribe?.();
  if (activeTelegramTurn) await clearPreview(activeTelegramTurn.chatId).catch(() => undefined);
  await runtime?.dispose();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await main();
