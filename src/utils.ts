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

export function chunkParagraphs(
  text: string,
  maxLength = MAX_MESSAGE_LENGTH,
): string[] {
  const chunks: string[] = [];
  let current = "";

  const paragraphs = text.split(/\n\n+/);

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    const separator = i > 0 ? "\n\n" : "";

    // If a single paragraph exceeds the limit, split it into fixed-size pieces
    if (paragraph.length > maxLength) {
      // Flush current chunk first, including separator if it fits
      if (current) {
        const withSep = current + separator;
        chunks.push(withSep.length <= maxLength ? withSep : current);
        current = "";
      }

      let remaining = paragraph;
      while (remaining.length > maxLength) {
        chunks.push(remaining.slice(0, maxLength));
        remaining = remaining.slice(maxLength);
      }
      current = remaining;
      continue;
    }

    // Try to fit this paragraph into the current chunk
    const candidate = current ? current + separator + paragraph : paragraph;
    if (candidate.length <= maxLength) {
      current = candidate;
    } else {
      // Doesn't fit — flush current (with separator if it fits) and start fresh
      if (current) {
        const withSep = current + separator;
        chunks.push(withSep.length <= maxLength ? withSep : current);
      }
      current = paragraph;
    }
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}
