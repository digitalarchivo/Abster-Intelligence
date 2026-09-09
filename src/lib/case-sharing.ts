/**
 * Shareable case URLs — local-first alternative to backend sync.
 *
 * Compresses a case (metadata + entities + relations + chat messages) into a
 * URL-safe string using LZ-string, then packs it into the hash fragment of a
 * `/case/share#<data>` URL. The receiver's browser decompresses and seeds the
 * case as read-only into their IndexedDB.
 *
 * Why URL hash (not query string)?
 *   - Hash fragments are never sent to the server, so the case data stays
 *     client-side only. This preserves the local-first security model: even
 *     if Vercel's logs captured URLs, they would not see the case data.
 *
 * Why LZ-string?
 *   - It's the smallest pure-JS compressor that runs in the browser without
 *     WebAssembly. A typical 50-entity case compresses to ~3-8 KB which fits
 *     comfortably under the practical URL length limit (~32 KB in modern
 *     browsers, ~8 KB safe across all).
 */

import LZString from "lz-string";
import type { Case, Entity, Relation, Chat, ChatMessage } from "../store/absterStore";
import { shareableCasePayloadSchema, SHARE_LIMITS, type ValidatedSharePayload } from "./validation";

export interface ShareableCasePayload {
  v: 1; // schema version for forward compatibility
  case: Case;
  entities: Entity[];
  relations: Relation[];
  chats: Chat[];
}

/**
 * Serialize + compress a case into a URL-safe string.
 * Returns null if the case is empty or compression fails.
 */
export function encodeCaseForSharing(
  caseData: Case,
  entities: Entity[],
  relations: Relation[],
  chats: Chat[],
): string | null {
  try {
    // Strip vault file Blobs from chat messages (they can't be serialized anyway).
    const safeChats: Chat[] = chats.map(c => ({
      ...c,
      messages: (c.messages || []).map((m: ChatMessage) => ({
        ...m,
        attachments: (m.attachments || []).map(a => ({
          id: a.id, name: a.name, type: a.type, size: a.size,
          // Omit url (it's a blob URL that won't survive a page reload)
        })),
      })),
    }));

    const payload: ShareableCasePayload = {
      v: 1,
      case: { ...caseData, activityLog: caseData.activityLog || [] },
      entities: entities.filter(e => e.caseId === caseData.id),
      relations: relations.filter(r => r.caseId === caseData.id),
      chats: safeChats.filter(c => c.caseId === caseData.id),
    };

    const json = JSON.stringify(payload);
    const compressed = LZString.compressToEncodedURIComponent(json);
    return compressed;
  } catch (err) {
    console.error("encodeCaseForSharing failed", err);
    return null;
  }
}

/**
 * Decompress + deserialize + VALIDATE a case payload from a URL hash.
 * Returns null if the input is malformed, oversized, or fails schema
 * validation. Every field is normalized (enums lowercased, invalid dates
 * repaired, unknown fields stripped) so a crafted link can never crash the
 * receiver's Dashboard.
 */
export function decodeCaseFromSharing(compressed: string): ValidatedSharePayload | null {
  try {
    if (!compressed || compressed.length < 10) {
      console.warn("decodeCaseFromSharing: empty or too-short input");
      return null;
    }
    // Guard 1: compressed input must fit a sane URL budget.
    if (compressed.length > SHARE_LIMITS.MAX_COMPRESSED_LENGTH) {
      console.warn("decodeCaseFromSharing: compressed payload exceeds limit", { inputLen: compressed.length });
      return null;
    }
    const json = LZString.decompressFromEncodedURIComponent(compressed);
    if (!json) {
      console.warn("decodeCaseFromSharing: LZString.decompress returned null", { inputLen: compressed.length, inputHead: compressed.slice(0, 50) });
      return null;
    }
    // Guard 2: reject oversized decompressed payloads before JSON.parse /
    // DB write — a ~13 KB link can decompress to 20+ MB.
    if (json.length > SHARE_LIMITS.MAX_DECOMPRESSED_LENGTH) {
      console.warn("decodeCaseFromSharing: decompressed payload exceeds limit", { jsonLen: json.length });
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (parseErr) {
      console.warn("decodeCaseFromSharing: JSON.parse failed", parseErr, { jsonHead: json.slice(0, 200) });
      return null;
    }
    // Schema validation + normalization + per-collection size caps.
    const parsed = shareableCasePayloadSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("decodeCaseFromSharing: schema validation failed", parsed.error.issues?.slice(0, 5));
      return null;
    }
    return parsed.data;
  } catch (err) {
    console.error("decodeCaseFromSharing failed", err);
    return null;
  }
}

/**
 * Build the full shareable URL for the given case.
 * Returns a URL like `https://abster-intelligence.vercel.app/case/share#<data>`.
 */
export function buildShareableUrl(
  caseData: Case,
  entities: Entity[],
  relations: Relation[],
  chats: Chat[],
): string | null {
  const compressed = encodeCaseForSharing(caseData, entities, relations, chats);
  if (!compressed) return null;
  if (typeof window === "undefined") return `/case/share#${compressed}`;
  const origin = window.location.origin;
  return `${origin}/case/share#${compressed}`;
}

/**
 * Approximate size estimate for the shareable URL, in KB.
 * Useful for warning the user when the case is too large to share via URL
 * (the practical limit is ~8 KB across all browsers).
 */
export function estimateShareableSize(compressed: string | null): number {
  if (!compressed) return 0;
  return Math.round(compressed.length / 1024 * 10) / 10;
}

/** Copy text to clipboard with a graceful fallback for non-secure contexts. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // Fallback: use a temporary textarea + execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    console.error("copyToClipboard failed", err);
    return false;
  }
}
