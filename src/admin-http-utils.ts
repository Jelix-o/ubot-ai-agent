import type {
  GroupMemberProfile,
  GroupMemoryEvidence,
  GroupMemoryEvidencePreview,
} from "./types.js";

export type EvidenceResponseMode = "full" | "preview";

const ADMIN_EVIDENCE_PREVIEW_LIMIT = 180;

export function paginationParams(url: URL, defaultPageSize: number, maxPageSize: number): { page: number; pageSize: number } {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const requestedPageSize = Number.parseInt(url.searchParams.get("pageSize") ?? String(defaultPageSize), 10) || defaultPageSize;
  const pageSize = Math.max(1, Math.min(maxPageSize, requestedPageSize));
  return { page, pageSize };
}

export function paginateItems<T>(
  items: T[],
  pagination: { page: number; pageSize: number },
): { items: T[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } } {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pagination.pageSize));
  const page = Math.min(Math.max(1, pagination.page), totalPages);
  const start = (page - 1) * pagination.pageSize;
  return {
    items: items.slice(start, start + pagination.pageSize),
    pagination: {
      page,
      pageSize: pagination.pageSize,
      total,
      totalPages,
    },
  };
}

export function normalizeSearchQuery(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeEvidenceMode(value: string | undefined): EvidenceResponseMode {
  return value === "preview" ? "preview" : "full";
}

export function formatEvidenceForResponse(
  evidence: GroupMemoryEvidence,
  mode: EvidenceResponseMode,
): GroupMemoryEvidence | GroupMemoryEvidencePreview {
  if (mode === "full") {
    return evidence;
  }

  return {
    startAt: evidence.startAt,
    endAt: evidence.endAt,
    messageCount: evidence.messageCount,
    speakerCount: evidence.speakers.length,
    summaryPreview: evidence.summary.length > ADMIN_EVIDENCE_PREVIEW_LIMIT
      ? `${evidence.summary.slice(0, ADMIN_EVIDENCE_PREVIEW_LIMIT)}...`
      : evidence.summary,
    hasFullEvidence: true,
  };
}

export function memberMatchesQuery(member: GroupMemberProfile, query: string): boolean {
  return [
    member.userId,
    member.displayName,
    member.card,
    member.nickname,
    member.role,
    member.note,
    ...(member.aliases ?? []),
  ].some((value) => String(value ?? "").toLowerCase().includes(query));
}
