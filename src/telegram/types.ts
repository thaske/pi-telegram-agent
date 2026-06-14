import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export interface TelegramConfig {
  botToken?: string;
  botUsername?: string;
  botId?: number;
  allowedUserId?: number;
  lastUpdateId?: number;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}
export interface TelegramChat {
  id: number;
  type: string;
}
export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
}
export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
export interface TelegramVideo {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
export interface TelegramAudio {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
export interface TelegramVoice {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}
export interface TelegramAnimation {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
export interface TelegramSticker {
  file_id: string;
  emoji?: string;
}
export interface TelegramMessage {
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
  rich_message?: TelegramRichMessage;
}
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}
export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}
export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
export interface TelegramGetFileResult {
  file_path: string;
}
export interface TelegramSentMessage {
  message_id: number;
}
export interface TelegramInputRichMessage {
  html?: string;
  markdown?: string;
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
}
export type TelegramRichText =
  | string
  | TelegramRichText[]
  | Record<string, unknown>;
export interface TelegramRichBlock {
  type: string;
  [key: string]: unknown;
}
export interface TelegramRichMessage {
  blocks: TelegramRichBlock[];
  is_rtl?: boolean;
}
export interface TelegramFileInfo {
  file_id: string;
  fileName: string;
  mimeType?: string;
  isImage: boolean;
}
export interface DownloadedTelegramFile {
  path: string;
  fileName: string;
  isImage: boolean;
  mimeType?: string;
}
export interface QueuedAttachment {
  path: string;
  fileName: string;
}
export interface PendingTelegramTurn {
  chatId: number;
  replyToMessageId: number;
  queuedAttachments: QueuedAttachment[];
  content: Array<TextContent | ImageContent>;
  historyText: string;
}
export interface TelegramPreviewState {
  mode: "draft" | "message";
  draftId?: number;
  messageId?: number;
  pendingText: string;
  lastSentText: string;
  flushTimer?: ReturnType<typeof setTimeout>;
}
export interface TelegramMediaGroupState {
  messages: TelegramMessage[];
  flushTimer?: ReturnType<typeof setTimeout>;
}
