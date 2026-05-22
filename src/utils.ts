import { MAX_MESSAGE_LENGTH } from "./constants.js";

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function guessExtensionFromMime(
  mimeType: string | undefined,
  fallback: string,
): string {
  if (!mimeType) return fallback;
  const ext = mimeType.split("/").pop();
  return ext ? `.${ext.replace(/[^a-zA-Z0-9]/g, "")}` : fallback;
}

export function guessMediaType(path: string): string | undefined {
  const ext = path.toLowerCase().split(".").pop();
  if (!ext) return undefined;
  if (["jpg", "jpeg"].includes(ext)) return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return undefined;
}

export function chunkParagraphs(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n\n+/)) {
    const parts =
      paragraph.match(
        new RegExp(`[\\s\\S]{1,${MAX_MESSAGE_LENGTH - 32}}`, "g"),
      ) ?? [];
    for (const part of parts) {
      const candidate = current ? `${current}\n\n${part}` : part;
      if (candidate.length <= MAX_MESSAGE_LENGTH) current = candidate;
      else {
        flush();
        current = part;
      }
    }
  }
  flush();
  return chunks.length ? chunks : [""];
}
