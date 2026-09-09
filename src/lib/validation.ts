/**
 * Shared zod schemas for all untrusted data entering Abster's IndexedDB:
 *   1. Shareable case URLs   (`/case/share#<lz-string>`)
 *   2. Backup import files   (Settings → Import Backup)
 *
 * Both channels are fully external input, so every payload is validated and
 * normalized before it is allowed to touch the database:
 *   - `settings` is NEVER imported: a crafted "backup" must not be able to
 *     inject an AIProvider with a foreign baseUrl and silently re-route
 *     every conversation to another endpoint.
 *   - Enums are normalized (trim + lowercase + fallback): a share link with
 *     `priority: "HIGH"` (uppercase) used to crash the Dashboard, whose
 *     lookup tables only contain lowercase keys.
 *   - Decompressed JSON length and per-collection counts are capped so a
 *     compressed "zip bomb" link cannot persist hundreds of MB into
 *     IndexedDB.
 *
 * Design notes:
 *   - `.catch(default)` is used for enum-ish fields so that *garbage degrades
 *     gracefully* instead of throwing — a shared case must never crash the
 *     receiver's app.
 *   - Unknown object properties are stripped (default zod behavior) so a
 *     crafted payload cannot smuggle extra fields into the DB.
 *   - Dates are validated: anything unparseable is replaced by "now" rather
 *     than persisted as NaN-poison that breaks the timeline sort.
 */

import { z } from "zod";

// ─── Bounded limits (generous for real data, bounded against abuse) ──────────

export const SHARE_LIMITS = {
  /** Max compressed hash length accepted in a /case/share URL. Real cases are
   *  ~3–8 KB; 64 KB is the practical URL ceiling with margin. */
  MAX_COMPRESSED_LENGTH: 64 * 1024,
  /** Max decompressed JSON accepted from a share link. */
  MAX_DECOMPRESSED_LENGTH: 4 * 1024 * 1024, // 4 MB
  MAX_ENTITIES: 5_000,
  MAX_RELATIONS: 20_000,
  MAX_CHATS: 200,
  MAX_MESSAGES_PER_CHAT: 5_000,
  MAX_STRING_LENGTH: 500_000, // per field
} as const;

export const BACKUP_LIMITS = {
  /** Reject absurdly large backup files before JSON.parse. */
  MAX_RAW_LENGTH: 100 * 1024 * 1024, // 100 MB
  MAX_ENTITIES: 50_000,
  MAX_RELATIONS: 100_000,
  MAX_CASES: 5_000,
  MAX_CHATS: 5_000,
  MAX_MESSAGES: 200_000,
  MAX_NOTES: 5_000,
  MAX_VAULT_FILES: 20_000,
  MAX_STRING_LENGTH: 2_000_000, // per field (case findings can be long)
} as const;

// ─── Normalizers ─────────────────────────────────────────────────────────────

const trimLower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);

/** priority/status/classification are UI enums — normalize instead of crash. */
const prioritySchema = z.preprocess(trimLower, z.enum(["critical", "high", "medium", "low"]).catch("medium"));
const statusSchema = z.preprocess(trimLower, z.enum(["active", "closed", "archived"]).catch("active"));
const classificationSchema = z.preprocess(
  trimLower,
  z.enum(["public", "confidential", "secret", "top_secret"]).catch("confidential"),
);

/** ISO date string; unparseable garbage degrades to "now" instead of NaN. */
const isoDate = (fallbackNow = true) =>
  z.preprocess((v) => {
    if (typeof v !== "string" && typeof v !== "number") return v;
    const ms = new Date(v as any).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : fallbackNow ? new Date().toISOString() : undefined;
  }, z.string().optional());

const boundedString = (max: number) => z.string().max(max).catch("");
const safeId = z.string().min(1).max(128).catch(() => `id-${Math.random().toString(36).slice(2, 10)}`);

// ─── Share payload schema (/case/share) ──────────────────────────────────────

const shareEntitySchema = z.object({
  id: safeId,
  caseId: z.string().max(128).optional(),
  type: boundedString(64).catch("GENERIC"),
  name: boundedString(SHARE_LIMITS.MAX_STRING_LENGTH).catch("UNNAMED"),
  description: z.string().max(SHARE_LIMITS.MAX_STRING_LENGTH).optional().catch(undefined),
  lat: z.number().finite().optional().catch(undefined),
  lng: z.number().finite().optional().catch(undefined),
  color: z.string().max(32).optional().catch(undefined),
  startDate: isoDate(false),
  endDate: isoDate(false),
  x: z.number().finite().optional().catch(undefined),
  y: z.number().finite().optional().catch(undefined),
  confidence: z.number().min(0).max(1).optional().catch(undefined),
  source: z.string().max(256).optional().catch(undefined),
  isVerified: z.boolean().optional().catch(undefined),
  isSuspicious: z.boolean().optional().catch(undefined),
  avatar: z.string().max(1024 * 1024).nullable().optional().catch(undefined),
  metadata: z.record(z.any()).optional().catch(undefined),
  ownerId: z.string().max(128).optional(),
  notes: z.string().max(SHARE_LIMITS.MAX_STRING_LENGTH).optional().catch(undefined),
});

const shareRelationSchema = z.object({
  id: safeId,
  caseId: z.string().max(128).optional(),
  source: z.string().max(128).catch(""),
  target: z.string().max(128).catch(""),
  type: boundedString(128).catch("RELATED_TO"),
  label: z.string().max(256).optional().catch(undefined),
  strength: z.number().min(0).max(100).optional().catch(undefined),
  date: isoDate(false),
  ownerId: z.string().max(128).optional(),
  notes: z.string().max(SHARE_LIMITS.MAX_STRING_LENGTH).optional().catch(undefined),
});

const shareMessageSchema = z.object({
  id: safeId,
  role: z.enum(["user", "assistant", "system"]).catch("assistant"),
  content: z.string().max(SHARE_LIMITS.MAX_STRING_LENGTH).catch(""),
  timestamp: z.number().int().nonnegative().catch(() => new Date().getTime()),
  attachments: z
    .array(
      z.object({
        id: safeId,
        name: z.string().max(512).catch("file"),
        type: z.string().max(128).catch("document"),
        size: z.number().min(0).catch(0),
        url: z.string().max(64).optional(), // blob URLs only survive per-session
      }),
    )
    .max(100)
    .optional()
    .catch([]),
  provider: z.string().max(128).optional().nullable().catch(null),
  modelId: z.string().max(256).optional().nullable().catch(null),
});

const shareChatSchema = z.object({
  id: safeId,
  title: boundedString(512).catch("Shared chat"),
  caseId: z.string().max(128).optional(),
  ownerId: z.string().max(128).optional(),
  createdAt: isoDate(),
  updatedAt: isoDate(),
  messages: z.array(shareMessageSchema).max(SHARE_LIMITS.MAX_MESSAGES_PER_CHAT).catch([]),
  metadata: z.record(z.any()).optional().catch(undefined),
});

const shareCaseSchema = z.object({
  id: safeId,
  codeName: boundedString(128).catch("SHARED"),
  title: boundedString(512).catch("Shared investigation"),
  description: z.string().max(SHARE_LIMITS.MAX_STRING_LENGTH).optional().catch(""),
  priority: prioritySchema,
  status: statusSchema,
  classification: classificationSchema,
  createdAt: isoDate(),
  updatedAt: isoDate(),
  closedAt: isoDate(false),
  leadInvestigator: boundedString(256).catch("[UNKNOWN]"),
  team: z.array(z.string().max(256)).max(200).catch([]),
  stats: z
    .object({
      entityCount: z.number().int().min(0).catch(0),
      locationCount: z.number().int().min(0).catch(0),
      eventCount: z.number().int().min(0).catch(0),
      toolResultsCount: z.number().int().min(0).catch(0),
      evidenceCount: z.number().int().min(0).catch(0),
    })
    .catch({ entityCount: 0, locationCount: 0, eventCount: 0, toolResultsCount: 0, evidenceCount: 0 }),
  tags: z.array(z.string().max(128)).max(100).catch([]),
  findings: z.string().max(SHARE_LIMITS.MAX_STRING_LENGTH).optional().catch(""),
  linkedCases: z.array(z.string().max(128)).max(1000).catch([]),
  template: z.string().max(128).nullable().optional().catch(null),
  checklist: z.array(z.boolean()).max(1000).catch([]),
  hypotheses: z
    .array(
      z.object({
        id: safeId,
        title: z.string().max(512).catch("Hypothesis"),
        status: z.string().max(64).catch("active"),
        confidence: z.number().min(0).max(100).catch(50),
        evidence: z.string().max(SHARE_LIMITS.MAX_STRING_LENGTH).optional().catch(""),
        createdAt: z.number().catch(() => new Date().getTime()),
      }),
    )
    .max(1000)
    .catch([]),
  activityLog: z
    .array(
      z.object({
        id: safeId,
        type: z.string().max(32).catch("INFO"),
        message: z.string().max(SHARE_LIMITS.MAX_STRING_LENGTH).catch("System event"),
        timestamp: z.number().catch(() => new Date().getTime()),
        user: z.string().max(256).optional(),
      }),
    )
    .max(5000)
    .catch([]),
  settings: z.record(z.any()).optional().catch(undefined),
  ownerId: z.string().max(128).optional(),
  notes: z.string().max(SHARE_LIMITS.MAX_STRING_LENGTH).optional().catch(undefined),
});

export const shareableCasePayloadSchema = z.object({
  v: z.literal(1).catch(1),
  case: shareCaseSchema,
  entities: z.array(shareEntitySchema).max(SHARE_LIMITS.MAX_ENTITIES).catch([]),
  relations: z.array(shareRelationSchema).max(SHARE_LIMITS.MAX_RELATIONS).catch([]),
  chats: z.array(shareChatSchema).max(SHARE_LIMITS.MAX_CHATS).catch([]),
});

export type ValidatedSharePayload = z.infer<typeof shareableCasePayloadSchema>;

// ─── Backup file schema (Settings → Import Backup) ───────────────────────────
//
// IMPORTANT: `settings` is deliberately absent from this schema. Backup files
// must never be able to (re)configure AI providers, endpoints, or OSINT API
// keys on the importing device — a crafted backup could otherwise point the
// chat at a foreign endpoint and silently exfiltrate every conversation. A
// `settings` key present in the file is simply ignored on import.

const backupEntitySchema = z.object({
  id: safeId,
  caseId: z.string().max(128).optional().catch(undefined),
  type: boundedString(64).catch("GENERIC"),
  name: boundedString(BACKUP_LIMITS.MAX_STRING_LENGTH).catch("UNNAMED"),
  description: z.string().max(BACKUP_LIMITS.MAX_STRING_LENGTH).optional().catch(undefined),
  lat: z.number().finite().optional().catch(undefined),
  lng: z.number().finite().optional().catch(undefined),
  polygon: z.array(z.object({ lat: z.number().finite(), lng: z.number().finite() })).max(10_000).optional().catch(undefined),
  color: z.string().max(32).optional().catch(undefined),
  startDate: isoDate(false),
  endDate: isoDate(false),
  x: z.number().finite().optional().catch(undefined),
  y: z.number().finite().optional().catch(undefined),
  confidence: z.number().min(0).max(1).optional().catch(undefined),
  source: z.string().max(256).optional().catch(undefined),
  isVerified: z.boolean().optional().catch(undefined),
  isSuspicious: z.boolean().optional().catch(undefined),
  avatar: z.string().max(1024 * 1024).nullable().optional().catch(undefined),
  metadata: z.record(z.any()).optional().catch(undefined),
  ownerId: z.string().max(128).optional(),
  notes: z.string().max(BACKUP_LIMITS.MAX_STRING_LENGTH).optional().catch(undefined),
});

const backupRelationSchema = z.object({
  id: safeId,
  caseId: z.string().max(128).optional().catch(undefined),
  source: z.string().max(128).catch(""),
  target: z.string().max(128).catch(""),
  type: boundedString(128).catch("RELATED_TO"),
  label: z.string().max(256).optional().catch(undefined),
  strength: z.number().min(0).max(100).optional().catch(undefined),
  date: isoDate(false),
  ownerId: z.string().max(128).optional(),
  notes: z.string().max(BACKUP_LIMITS.MAX_STRING_LENGTH).optional().catch(undefined),
});

const backupCaseSchema = shareCaseSchema; // same shape + normalization rules

const backupMessageSchema = z.object({
  id: safeId,
  chatId: z.string().max(128).optional().catch(undefined),
  role: z.enum(["user", "assistant", "system"]).catch("assistant"),
  content: z.string().max(BACKUP_LIMITS.MAX_STRING_LENGTH).catch(""),
  timestamp: z.number().int().nonnegative().catch(() => new Date().getTime()),
  attachments: z
    .array(
      z.object({
        id: safeId,
        name: z.string().max(512).catch("file"),
        type: z.string().max(128).catch("document"),
        size: z.number().min(0).catch(0),
        url: z.string().max(64).optional(),
      }),
    )
    .max(100)
    .optional()
    .catch([]),
  provider: z.string().max(128).optional().nullable().catch(null),
  modelId: z.string().max(256).optional().nullable().catch(null),
});

const backupChatSchema = z.object({
  id: safeId,
  title: boundedString(512).catch("Imported chat"),
  caseId: z.string().max(128).optional().catch(undefined),
  ownerId: z.string().max(128).optional(),
  createdAt: isoDate(),
  updatedAt: isoDate(),
  metadata: z.record(z.any()).optional().catch(undefined),
});

const backupNoteSchema = z.object({
  id: safeId,
  caseId: z.string().max(128).optional().catch(undefined),
  content: z.string().max(BACKUP_LIMITS.MAX_STRING_LENGTH).catch(""),
  ownerId: z.string().max(128).optional(),
  updatedAt: isoDate(),
});

const backupVaultFileSchema = z.object({
  id: safeId,
  name: boundedString(512).catch("file"),
  type: z.string().max(128).catch("document"),
  size: z.number().min(0).catch(0),
  uploadedAt: isoDate(),
  chatId: z.string().max(128).optional().catch(undefined),
  ownerId: z.string().max(128).optional(),
  url: z.string().max(64).nullable().optional().catch(null),
  data: z.null().optional().catch(null), // blobs never travel inside JSON
});

export const backupDataSchema = z.object({
  v: z.number().optional(),
  exportedAt: z.string().optional(),
  entities: z.array(backupEntitySchema).max(BACKUP_LIMITS.MAX_ENTITIES).catch([]),
  relations: z.array(backupRelationSchema).max(BACKUP_LIMITS.MAX_RELATIONS).catch([]),
  cases: z.array(backupCaseSchema).max(BACKUP_LIMITS.MAX_CASES).catch([]),
  chats: z.array(backupChatSchema).max(BACKUP_LIMITS.MAX_CHATS).catch([]),
  messages: z.array(backupMessageSchema).max(BACKUP_LIMITS.MAX_MESSAGES).catch([]),
  notes: z.array(backupNoteSchema).max(BACKUP_LIMITS.MAX_NOTES).catch([]),
  vaultFiles: z.array(backupVaultFileSchema).max(BACKUP_LIMITS.MAX_VAULT_FILES).catch([]),
});

export type ValidatedBackupData = z.infer<typeof backupDataSchema>;
