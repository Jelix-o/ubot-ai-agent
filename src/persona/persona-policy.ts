import type { SkillDefinition } from "../types.js";
import { COMMON_PERSONA_CHAT_RULES } from "./common-chat-behavior.js";
import { HUIXIAN_CONVERSATION_RULES, normalizeHuixianStyleRules, stripManagedConversationSections } from "./huixian-conversation-policy.js";

/** Compile one effective persona without mutating the editable saved profile. */
export function compilePersonaPolicy(profile: SkillDefinition): {
  systemPrompt: string;
  sharedRules: readonly string[];
  styleRules: string[];
} {
  if (profile.id !== "huixian") {
    return { systemPrompt: profile.systemPrompt, sharedRules: COMMON_PERSONA_CHAT_RULES, styleRules: [...new Set(profile.styleRules)] };
  }
  return {
    systemPrompt: stripManagedConversationSections(profile.systemPrompt),
    sharedRules: COMMON_PERSONA_CHAT_RULES,
    styleRules: [...normalizeHuixianStyleRules(profile.styleRules), ...HUIXIAN_CONVERSATION_RULES],
  };
}
