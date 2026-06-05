import type { EvidenceFull, EvidencePreview } from "../services/api";

export function formatDateTime(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, "0"),
    `${date.getDate()}`.padStart(2, "0"),
  ];
  const timeParts = [
    `${date.getHours()}`.padStart(2, "0"),
    `${date.getMinutes()}`.padStart(2, "0"),
    `${date.getSeconds()}`.padStart(2, "0"),
  ];
  return `${parts.join("-")} ${timeParts.join(":")}`;
}

export function profileTypeLabel(type?: "overall" | "yesterday"): string {
  return type === "yesterday" ? "昨日画像" : "群聊画像";
}

export function evidenceSummary(evidence?: EvidenceFull | EvidencePreview): string {
  if (!evidence) return "暂无来源证据";
  if ("summary" in evidence) return evidence.summary || "暂无来源摘要";
  return evidence.summaryPreview || "暂无来源摘要";
}

export function evidenceSpeakers(evidence?: EvidenceFull | EvidencePreview): string {
  if (!evidence) return "-";
  if ("speakers" in evidence) {
    return evidence.speakers.map((speaker) => `${speaker.userName || speaker.userId}(${speaker.userId})`).join("、") || "-";
  }
  return `${evidence.speakerCount} 人`;
}
