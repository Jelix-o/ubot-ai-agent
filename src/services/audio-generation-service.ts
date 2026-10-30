import { createHash, randomUUID } from "node:crypto";
import type { V3StateRepository } from "./v3-state-repository.js";
import { AudioSettingsService } from "./audio-settings-service.js";
import { AudioProviderError, SeedAudioProvider } from "./seed-audio-provider.js";
import { AudioAssetStore } from "./audio-asset-store.js";
import { containsSensitiveCredential } from "./explicit-memory-service.js";
import { isInteractionQuietHour } from "./group-interaction-service.js";
import { InteractionDiagnostics } from "./interaction-diagnostics.js";

type AudioKind = "speech" | "song";
type AudioStatus = "queued" | "running" | "queued_delivery" | "succeeded" | "failed" | "unknown" | "skipped";
export interface AudioJob {
  id: string; groupId: string; userId: string; kind: AudioKind; text?: string; automatic: boolean;
  createdAt: number; status: AudioStatus; startedAt?: number; finishedAt?: number; day?: string;
  reservedSeconds?: number; chargedSeconds?: number; captionOutboxId?: number; outboxId?: number;
  captionAlreadySent?: boolean; progressOutboxId?: number; errorCode?: string;
}
interface AudioLock { jobId: string; expiresAt: number }
export const audioDay = (now: number) => new Date(now + 8*3600_000).toISOString().slice(0,10);
export function permitsAutomaticVoice(args: { directed: boolean; input: string; reply: string; automaticReply?: boolean; knowledge?: boolean }, now = Date.now(), random = Math.random): boolean {
  return args.directed && !args.automaticReply && !args.knowledge && !isInteractionQuietHour(now) && [...args.reply].length <= 120 && Boolean(args.reply.trim())
    && !/https?:|```|[#@]|\[CQ:|(?:急救|自杀|报警|受伤|住院|抑郁|诊断|法律|合同|投资|代码|报错|查询|教程|步骤|翻译)/iu.test(args.input + args.reply) && random() < 0.1;
}
export class AudioGenerationService {
  private running?: Promise<void>;
  private controller?: AbortController;
  private stopped = false;
  readonly settings: AudioSettingsService;
  readonly assets: AudioAssetStore;
  constructor(private readonly repo: V3StateRepository, root: string, private readonly provider: Pick<SeedAudioProvider, "generate"> = new SeedAudioProvider(), private readonly now = Date.now) {
    this.settings = new AudioSettingsService(repo); this.assets = new AudioAssetStore(root, repo);
  }
  enqueue(args: { groupId: string; userId: string; kind: AudioKind; text: string; automatic?: boolean; sourceKey?: string; captionOutboxId?: number; captionAlreadySent?: boolean }): AudioJob {
    return this.repo.runAtomically(() => {
      this.allowed(args.groupId, args.userId, args.kind);
      const text = args.text.trim();
      if (!text || [...text].length > (args.kind === "song" ? 100 : 500) || containsSensitiveCredential(text)) throw new Error("audio_text_invalid");
      const id = "audio-" + createHash("sha256").update(JSON.stringify([args.groupId,args.userId,args.kind,args.sourceKey ?? randomUUID()])).digest("hex").slice(0,32);
      const existing = this.job(id); if (existing) return existing;
      const jobs = this.jobs(), now = this.now();
      if (jobs.filter(j => j.status === "queued").length >= 4) throw new Error("audio_queue_full");
      if (args.kind === "song" && jobs.some(j => j.kind === "song" && j.status !== "skipped" && (j.groupId === args.groupId && now-j.createdAt < 600_000 || j.userId === args.userId && now-j.createdAt < 300_000))) throw new Error("audio_cooldown");
      if (args.automatic && (isInteractionQuietHour(now) || !this.settings.get().automaticVoiceEnabled || jobs.some(j => j.groupId === args.groupId && j.kind === "speech" && now-j.createdAt < 300_000))) throw new Error("audio_cooldown");
      const job: AudioJob = { id, groupId: args.groupId, userId: args.userId, kind: args.kind, text, automatic: args.automatic === true, createdAt: now, status: "queued", captionOutboxId: args.captionOutboxId, captionAlreadySent: args.captionAlreadySent };
      this.save(job); return job;
    });
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running) this.running = this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }
  async stop(): Promise<void> { this.stopped = true; this.controller?.abort(); await this.running; }
  usage() {
    const day = audioDay(this.now()), jobs = this.jobs().filter(j => j.day === day);
    return { day, chargedSeconds: jobs.reduce((n,j) => n+(j.chargedSeconds ?? 0),0), reservedSeconds: jobs.reduce((n,j) => n+(j.chargedSeconds === undefined ? j.reservedSeconds ?? 0 : 0),0),
      queued: this.jobs().filter(j => j.status === "queued").length, running: this.jobs().filter(j => j.status === "running").length,
      recent: this.jobs().sort((a,b) => b.createdAt-a.createdAt).slice(0,20).map(({ id, groupId, kind, status, createdAt, finishedAt, chargedSeconds, errorCode }) => ({ id, groupId, kind, status, createdAt, finishedAt, chargedSeconds, errorCode })) };
  }
  private jobs(): AudioJob[] { return this.repo.listDocuments<AudioJob>("audio-job").map(d => d.value); }
  private job(id: string): AudioJob | null { return this.repo.getDocument<AudioJob | null>("audio-job", id, null); }
  private save(job: AudioJob): void { this.repo.saveDocument("audio-job", job.id, job, this.now()); }
  private allowed(groupId: string, userId: string, kind: AudioKind): void {
    const group = this.repo.getGroup(groupId), config = this.settings.internal();
    if (!config.enabled || !config.apiKey || !group || group.enabled === false || group.botMuted || group.blacklistedUserIds?.includes(userId) || (kind === "song" ? !group.singingEnabled : !group.audioReplyEnabled)) throw new Error("audio_disabled");
  }
  private claim(): AudioJob | undefined {
    if (this.stopped) return undefined;
    return this.repo.runAtomically(() => {
      const now = this.now();
      for (const job of this.jobs().filter(j => j.status === "running" && now-(j.startedAt ?? now) >= 150_000)) this.finish(job, "unknown", "audio_result_unknown");
      const lock = this.repo.getDocument<AudioLock | null>("audio-generation-lock", "global", null);
      if (lock && lock.expiresAt > now) return undefined;
      for (const job of this.jobs().filter(j => j.status === "queued").sort((a,b) => a.createdAt-b.createdAt)) {
        try { this.allowed(job.groupId, job.userId, job.kind); } catch { this.finish(job,"skipped","audio_disabled"); continue; }
        if (now-job.createdAt > 600_000) { this.finish(job,"skipped","audio_request_expired"); continue; }
        const day = audioDay(now), today = this.jobs().filter(j => j.day === day);
        const seconds = today.reduce((n,j) => n+(j.chargedSeconds ?? j.reservedSeconds ?? 0),0);
        if (seconds + 120 > 1800 || today.filter(j => j.groupId === job.groupId && j.kind === job.kind).length >= (job.kind === "song" ? 3 : 20)) { this.finish(job,"skipped","audio_daily_limit"); continue; }
        job.status = "running"; job.startedAt = now; job.day = day; job.reservedSeconds = 120;
        this.save(job); this.repo.saveDocument("audio-generation-lock", "global", { jobId: job.id, expiresAt: now+150_000 } satisfies AudioLock);
        return job;
      }
      return undefined;
    });
  }
  private async drain(): Promise<void> {
    await this.assets.cleanup(this.now());
    for (const job of this.jobs()) {
      if (job.status === "queued_delivery" && job.outboxId) {
        const row = this.repo.sharedDb.db.prepare("SELECT status FROM outbox WHERE id=?").get(job.outboxId) as {status:string}|undefined;
        if (row?.status === "sent") this.finish(job,"succeeded");
        else if (row?.status === "failed") this.finish(job,"unknown","audio_delivery_unconfirmed");
      }
      if (job.day !== audioDay(this.now()) && this.now()-job.createdAt > 86_400_000 && !["queued","running"].includes(job.status)) this.repo.deleteDocument("audio-job", job.id);
    }
    for (;;) {
      const job = this.claim(); if (!job) return;
      this.controller = new AbortController();
      const progress = setTimeout(() => {
        this.repo.runAtomically(() => {
          const current = this.job(job.id);
          if (!current || current.status !== "running" || current.automatic || current.progressOutboxId) return;
          try { this.allowed(current.groupId,current.userId,current.kind); } catch { return; }
          current.progressOutboxId = this.notice(job,job.kind === "song" ? "正在准备原创短歌，完成后会发字幕和音频。" : "语音还在准备，完成后会发来。","audio_progress"); this.save(current);
        });
      }, 5000); progress.unref();
      try {
        this.allowed(job.groupId,job.userId,job.kind);
        const audio = await this.provider.generate(this.settings.internal().apiKey!,job.kind,job.text!,this.controller.signal);
        const current = this.job(job.id); if (!current || current.status !== "running") continue;
        if (!Number.isFinite(audio.originalDuration) || audio.originalDuration <= 0 || audio.originalDuration > 120) throw new AudioProviderError("audio_result_unknown",true);
        current.chargedSeconds = Math.ceil(audio.originalDuration); this.save(current);
        if (job.kind === "speech" && compact(audio.caption) !== compact(job.text!) || job.kind === "song" && (!audio.caption || audio.caption.length > 1500 || audio.duration < 15 || audio.duration > 30)) throw new AudioProviderError("audio_caption_mismatch",false);
        this.allowed(job.groupId,job.userId,job.kind);
        await this.assets.save(job.id,job.groupId,audio);
        this.repo.runAtomically(() => {
          this.allowed(job.groupId,job.userId,job.kind);
          const latest = this.job(job.id); if (!latest || latest.status !== "running") return;
          if (!latest.captionOutboxId && !latest.captionAlreadySent) latest.captionOutboxId = this.notice(job,`${job.kind === "song" ? "【原创短歌】" : "【语音字幕】"}${audio.caption}`,"audio_caption");
          latest.outboxId = this.repo.sharedDb.enqueueOutbox(job.groupId,null,job.id,"audio_asset"); latest.status = "queued_delivery"; delete latest.text;
          this.save(latest); this.release(latest);
        });
      } catch (error) {
        const current = this.job(job.id);
        if (current?.status === "running") {
          const unknown = !(error instanceof AudioProviderError) || error.outcomeUnknown;
          if (!unknown && current.chargedSeconds === undefined) current.chargedSeconds = 0;
          this.repo.runAtomically(() => this.finish(current, unknown ? "unknown" : "failed", error instanceof AudioProviderError ? error.code : "audio_result_unknown"));
        }
      } finally { clearTimeout(progress); this.controller = undefined; }
    }
  }
  private release(job: AudioJob): void {
    const lock = this.repo.getDocument<AudioLock | null>("audio-generation-lock","global",null);
    if (lock?.jobId === job.id) this.repo.deleteDocument("audio-generation-lock","global");
  }
  private finish(job: AudioJob, status: AudioStatus, errorCode?: string): void {
    job.status = status; job.finishedAt = this.now(); job.errorCode = errorCode;
    if (errorCode && !job.automatic && status !== "succeeded" && errorCode !== "audio_delivery_unconfirmed") {
      try { this.allowed(job.groupId,job.userId,job.kind);
        this.notice(job,job.kind === "song" ? "这次短歌未能确认生成或送达，请稍后重新点播。" : `这次语音未能确认生成或送达，先发文字：${job.text ?? "原回复见上文"}`,"audio_caption");
      } catch { /* Closed groups stay silent. */ }
    }
    delete job.text; this.save(job); this.release(job);
    new InteractionDiagnostics(this.repo.sharedDb).record(job.groupId,"audio",status === "queued_delivery" ? "queued" : status,{},this.now());
  }
  private notice(job: AudioJob, text: string, kind: "audio_caption" | "audio_progress"): number {
    return this.repo.sharedDb.enqueueOutbox(job.groupId,null,JSON.stringify({jobId:job.id,text}),kind);
  }
}
function compact(text: string): string { return text.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu,""); }
