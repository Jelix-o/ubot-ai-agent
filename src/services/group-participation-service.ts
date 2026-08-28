import { logWarn } from "../logger.js";
import type { GroupBotConfig, SystemSettings } from "../types.js";
import { parseExplicitMemoryRequest } from "./explicit-memory-service.js";
import { ParticipationPolicy, type ParticipationDecision } from "./participation-policy.js";

const CHENGFENG_TRIGGER_GROUP_ID = "866209871";
const CHENGFENG_TRIGGER_KEYWORD = "乘风";

export interface GroupParticipationConfigReader {
  getGroup(groupId: string): Promise<GroupBotConfig | undefined>;
}

export interface GroupParticipationSettingsReader {
  get(): Promise<Pick<SystemSettings, "defaultTriggerKeywords">>;
}

export interface GroupParticipationDecisionOptions {
  hasImages?: boolean;
  /** Set only after the worker has verified a same-group bot reply receipt. */
  replyToBot?: boolean;
}

/**
 * Coordinates the pure participation policy with the persisted per-group and
 * system settings it needs. Keeping these reads outside BotApplication lets
 * ingress/worker reuse one explainable decision boundary without pulling in
 * conversation, command, or transport dependencies.
 */
export class GroupParticipationService {
  constructor(
    private readonly groupConfigReader: GroupParticipationConfigReader,
    private readonly settingsReader?: GroupParticipationSettingsReader,
    private readonly policy = new ParticipationPolicy(),
  ) {}

  async decide(
    groupId: string,
    text: string,
    hasAtBot: boolean,
    options: GroupParticipationDecisionOptions = {},
  ): Promise<ParticipationDecision> {
    const groupConfig = await this.groupConfigReader.getGroup(groupId);
    const normalized = text.trim();
    const isCommand = normalized.startsWith("#");
    const isExplicitMemoryRequest = Boolean(parseExplicitMemoryRequest(normalized));
    const isConversationCommand = isAiConversationCommand(normalized);
    const keywordTriggered = groupConfig && groupConfig.enabled !== false && groupConfig.botMuted !== true && allowsKeywordParticipation(groupConfig)
      ? await this.shouldTriggerKeyword(groupConfig, text, hasAtBot, text)
      : false;

    return this.policy.decide({
      text,
      hasAtBot,
      // A bare OneBot reply segment can point at any group member. Only the
      // worker may set this after a same-group receipt-table lookup.
      hasReply: options.replyToBot === true,
      hasImages: options.hasImages === true,
      groupConfigured: Boolean(groupConfig),
      groupEnabled: groupConfig?.enabled !== false,
      groupMuted: groupConfig?.botMuted === true,
      isCommand,
      isExplicitMemoryRequest,
      isConversationCommand,
      keywordTriggered,
    });
  }

  async shouldTriggerKeyword(
    groupConfig: GroupBotConfig,
    text: string,
    hasAtBot: boolean,
    commandText = text,
  ): Promise<boolean> {
    if (!allowsKeywordParticipation(groupConfig) || hasAtBot || commandText.trim().startsWith("#")) {
      return false;
    }

    const keywords = groupConfig.triggerKeywords && groupConfig.triggerKeywords.length > 0
      ? groupConfig.triggerKeywords
      : await this.getDefaultTriggerKeywords(groupConfig.groupId);
    return keywords.some((item) => item.enabled !== false && item.keyword && text.includes(item.keyword));
  }

  private async getDefaultTriggerKeywords(groupId: string): Promise<SystemSettings["defaultTriggerKeywords"]> {
    if (this.settingsReader) {
      try {
        const settings = await this.settingsReader.get();
        if (settings.defaultTriggerKeywords.length > 0) {
          return settings.defaultTriggerKeywords;
        }
      } catch (error) {
        logWarn("Failed to load system default trigger keywords.", {
          groupId,
          error: (error as Error).message,
        });
      }
    }

    // Preserve the established migration-era default until it is replaced by
    // an explicit system setting. It is a participation default, not a bot
    // orchestration concern.
    return groupId === CHENGFENG_TRIGGER_GROUP_ID
      ? [{ keyword: CHENGFENG_TRIGGER_KEYWORD, enabled: true }]
      : [];
  }
}

export function allowsKeywordParticipation(groupConfig: GroupBotConfig): boolean {
  return groupConfig.participationMode === "mentions_and_keywords" ||
    groupConfig.participationMode === "selected_members";
}

/** Commands that intentionally enter the conversational model path. */
export function isAiConversationCommand(text: string): boolean {
  return /^(?:#语音(?:\s|$)|#唱歌(?:\s|$))/u.test(text.trim());
}
