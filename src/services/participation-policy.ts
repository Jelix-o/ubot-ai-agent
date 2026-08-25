export type ParticipationAction =
  | "ignore"
  | "observe"
  | "reply"
  | "react"
  | "task"
  | "admin_command";

export type ParticipationReason =
  | "group_unavailable"
  | "empty_message"
  | "administrative_command"
  | "conversation_command"
  | "direct_mention"
  | "explicit_reply"
  | "keyword_trigger"
  | "muted_observation"
  | "ambient_observation";

export interface ParticipationInput {
  text: string;
  hasAtBot: boolean;
  hasReply: boolean;
  hasImages: boolean;
  groupConfigured: boolean;
  groupEnabled: boolean;
  groupMuted: boolean;
  isCommand: boolean;
  isConversationCommand: boolean;
  keywordTriggered: boolean;
}

export interface ParticipationDecision {
  action: ParticipationAction;
  reason: ParticipationReason;
  score: number;
  policyVersion: string;
  signals: Record<string, boolean>;
}

/**
 * The first, intentionally conservative version of the group-participation
 * policy. It explains the existing response contract in one place without
 * inventing unsolicited replies. Later versions can enable `react` after
 * shadow metrics show that a group has enough tolerance for it.
 */
export class ParticipationPolicy {
  static readonly version = "v1-conservative";

  decide(input: ParticipationInput): ParticipationDecision {
    const signals = {
      hasAtBot: input.hasAtBot,
      hasReply: input.hasReply,
      hasImages: input.hasImages,
      isCommand: input.isCommand,
      isConversationCommand: input.isConversationCommand,
      groupMuted: input.groupMuted,
      keywordTriggered: input.keywordTriggered,
    };
    const hasContent = Boolean(input.text.trim()) || input.hasImages;

    if (!input.groupConfigured || !input.groupEnabled) {
      return this.result("ignore", "group_unavailable", 0, signals);
    }
    if (!hasContent) {
      return this.result("ignore", "empty_message", 0, signals);
    }
    if (input.isCommand) {
      return input.isConversationCommand
        ? this.result("reply", "conversation_command", 1, signals)
        : this.result("admin_command", "administrative_command", 1, signals);
    }
    if (input.hasAtBot) {
      return this.result("reply", "direct_mention", 1, signals);
    }
    if (input.hasReply) {
      return this.result("reply", "explicit_reply", 0.98, signals);
    }
    if (input.groupMuted) {
      return this.result("observe", "muted_observation", 0, signals);
    }
    if (input.keywordTriggered) {
      return this.result("reply", "keyword_trigger", 0.82, signals);
    }
    return this.result("observe", "ambient_observation", 0, signals);
  }

  private result(
    action: ParticipationAction,
    reason: ParticipationReason,
    score: number,
    signals: Record<string, boolean>,
  ): ParticipationDecision {
    return {
      action,
      reason,
      score,
      policyVersion: ParticipationPolicy.version,
      signals,
    };
  }
}
