import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH =
  process.env.PI_TELEGRAM_CONFIG ??
  join(homedir(), ".pi", "agent", "telegram.json");
export const TEMP_DIR =
  process.env.PI_TELEGRAM_TMP ??
  join(homedir(), ".pi", "agent", "tmp", "telegram-agent");
export const PENDING_TURN_PATH = join(TEMP_DIR, "pending-turn.json");
export const CWD = process.env.PI_TELEGRAM_CWD ?? process.cwd();
export const TELEGRAM_PREFIX = "[telegram]";
export const MAX_MESSAGE_LENGTH = 4096;
export const MAX_RICH_MESSAGE_LENGTH = 32768;
export const MAX_ATTACHMENTS_PER_TURN = 10;
export const PREVIEW_THROTTLE_MS = 750;
export const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
export const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;
