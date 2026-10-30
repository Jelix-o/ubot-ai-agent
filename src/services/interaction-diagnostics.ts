import { randomUUID } from "node:crypto";
import type { SharedDb } from "../shared/sqlite.js";

const TYPE = "interaction-diagnostic";
const RETENTION_MS = 7 * 86_400_000;
export interface InteractionDiagnostic {
  at: number;
  groupId: string;
  feature: "meme" | "ambient" | "poke" | "audio";
  reason: string;
  metrics: Record<string, number>;
}
export const INTERACTION_REASON_LABELS: Record<string, string> = {
  sent_candidate: "已选出素材", cooldown: "冷却中", no_match: "未选择有效分类", probability_miss: "本次未命中随机概率",
  policy_disabled: "功能或策略未开启", asset_unavailable: "分类暂无可用素材", quiet_hours: "北京时间 01:00–07:00 暂停主动接话",
  pending_reply: "已有回复正在处理或发送", recent_bot_reply: "机器人最近一分钟发过言", ambient_cooldown: "主动接话十分钟冷却中",
  evaluation_cooldown: "一分钟内已判断过", insufficient_messages: "两分钟内不足三条有效消息或两位成员",
  stale_source: "没有可判断的新消息", evaluating: "已进入回复欲望判断", queued: "动作已进入发送队列", invalid_event: "事件目标或时效不满足条件",
  selected_member_priority: "优先处理指定成员实时对话", model_skipped: "模型判断本次无需接话", evaluation_failed: "本次判断未完成",
};
/** This store accepts only numeric counters and controlled reason codes, never chat or model text. */
export class InteractionDiagnostics {
  constructor(private readonly db: SharedDb) {}
  record(groupId: string, feature: InteractionDiagnostic["feature"], reason: string, metrics: Record<string, number> = {}, at = Date.now()): void {
    const safe = Object.fromEntries(Object.entries(metrics).filter(([key,value]) => /^[a-zA-Z]{1,30}$/.test(key) && Number.isFinite(value)).slice(0,10));
    if (!/^[a-z_]{1,60}$/.test(reason)) return;
    this.prune(at);
    this.db.db.prepare("INSERT INTO v3_state_documents(document_type,document_key,document_json,updated_at) VALUES(?,?,?,?)")
      .run(TYPE, randomUUID(), JSON.stringify({ at, groupId, feature, reason, metrics: safe } satisfies InteractionDiagnostic), at);
  }
  list(groupId: string, limit = 30, now = Date.now()): InteractionDiagnostic[] {
    this.prune(now);
    return (this.db.db.prepare("SELECT document_json FROM v3_state_documents WHERE document_type=? AND json_extract(document_json,'$.groupId')=? ORDER BY updated_at DESC LIMIT ?")
      .all(TYPE, groupId, Math.max(1,Math.min(100,limit))) as Array<{document_json:string}>).map(r => JSON.parse(r.document_json) as InteractionDiagnostic);
  }
  private prune(now: number): void {
    this.db.db.prepare("DELETE FROM v3_state_documents WHERE document_type=? AND updated_at<?").run(TYPE, now - RETENTION_MS);
  }
}
