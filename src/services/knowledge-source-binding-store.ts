import type { SystemCommandConfig } from "../types.js";
import type {
  KnowledgeSourceBinding,
  KnowledgeSourceId,
  V3StateRepository,
} from "./v3-state-repository.js";

export type { KnowledgeSourceId } from "./v3-state-repository.js";

export const DEFAULT_KNOWLEDGE_SOURCE_COMMANDS: Readonly<Record<KnowledgeSourceId, string>> = {
  private_enterprise_ranking: "#民营企业排名",
  group_faq: "#群知识库",
};

const BUILTIN_COMMANDS = [
  "#对话", "#clear", "#网页", "#html", "#画图", "#生图", "#功能", "#帮助", "#命令",
  "#模型", "#闭嘴", "#说话", "#实时对话", "#日报", "#节假日", "#定时任务", "#状态",
  "#操作日志", "#服务器", "#告警", "#记忆", "#知识库", "#拉黑", "#健康检查", "#健康",
  "#管理员", "#技能", "#人格", "#角色",
];

export class KnowledgeSourceBindingStore {
  constructor(private readonly repository?: Pick<
    V3StateRepository,
    "getKnowledgeSourceBinding" | "listKnowledgeSourceBindings" | "saveKnowledgeSourceBinding"
  >) {}

  get writable(): boolean { return Boolean(this.repository); }

  get(source: KnowledgeSourceId, groupId = ""): string {
    return this.repository?.getKnowledgeSourceBinding(source, groupId)?.command ??
      DEFAULT_KNOWLEDGE_SOURCE_COMMANDS[source];
  }

  list(): KnowledgeSourceBinding[] {
    return this.repository?.listKnowledgeSourceBindings() ?? [];
  }

  save(input: Omit<KnowledgeSourceBinding, "updatedAt"> & { updatedAt?: string }): KnowledgeSourceBinding {
    if (!this.repository) throw new Error("knowledge_source_bindings_unavailable");
    return this.repository.saveKnowledgeSourceBinding({
      ...input,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    });
  }
}

export function normalizeKnowledgeSourceCommand(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const command = value.trim();
  if (command.length > 32 || !/^#[\p{L}\p{N}_-]{1,31}$/u.test(command)) return undefined;
  return command;
}

export function knowledgeCommandConflict(
  command: string,
  current: { source: KnowledgeSourceId; groupId: string },
  bindings: readonly KnowledgeSourceBinding[],
  runtimeCommands: readonly SystemCommandConfig[],
  effectiveRankingCommand: string,
): string | undefined {
  const conflictsWith = (other: string) => commandsOverlap(command, other);
  const builtin = BUILTIN_COMMANDS.find(conflictsWith);
  if (builtin) return `不能与内置命令 ${builtin} 重叠`;

  const configured = runtimeCommands.flatMap((item) => [item.primary, ...item.aliases]).find(conflictsWith);
  if (configured) return `不能与系统命令 ${configured} 重叠`;

  if (current.source === "private_enterprise_ranking") {
    if (conflictsWith(DEFAULT_KNOWLEDGE_SOURCE_COMMANDS.group_faq)) {
      return `不能与群 FAQ 默认命令 ${DEFAULT_KNOWLEDGE_SOURCE_COMMANDS.group_faq} 重叠`;
    }
    const faq = bindings.find((item) => item.source === "group_faq" && conflictsWith(item.command));
    if (faq) return `不能与群 ${faq.groupId} 的 FAQ 命令 ${faq.command} 重叠`;
  } else {
    if (conflictsWith(effectiveRankingCommand)) return `不能与榜单命令 ${effectiveRankingCommand} 重叠`;
  }
  return undefined;
}

/** System-command edits must observe the same namespace as knowledge edits. */
export function systemKnowledgeCommandConflict(commands: readonly SystemCommandConfig[], store: KnowledgeSourceBindingStore): boolean {
  const reserved = [store.get("private_enterprise_ranking"), DEFAULT_KNOWLEDGE_SOURCE_COMMANDS.group_faq,
    ...store.list().filter((item) => item.source === "group_faq").map((item) => item.command)];
  return commands.some((item) => [item.primary, ...item.aliases]
    .some((command) => reserved.some((other) => commandsOverlap(command, other))));
}

function commandsOverlap(left: string, right: string): boolean {
  const normalizedLeft = left.normalize("NFKC").toLocaleLowerCase();
  const normalizedRight = right.normalize("NFKC").toLocaleLowerCase();
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}
