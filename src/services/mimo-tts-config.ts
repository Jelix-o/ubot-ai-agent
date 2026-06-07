export const MIMO_TTS_BASE_URL = "https://api.xiaomimimo.com/v1";
export const LEGACY_MIMO_TTS_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
export const MIMO_TTS_MODEL = "mimo-v2.5-tts";
export const MIMO_TTS_VOICE_DESIGN_MODEL = "mimo-v2.5-tts-voicedesign";
export const MIMO_TTS_VOICE_CLONE_MODEL = "mimo-v2.5-tts-voiceclone";
export const LEGACY_MIMO_TTS_MODEL = "mimo-v2-tts";
export const MIMO_TTS_MODEL_ID = "tts-mimo-v25";
export const ENV_TTS_MODEL_ID = "tts";

export const MIMO_TTS_PRESET_VOICES = [
  "mimo_default",
  "冰糖",
  "茉莉",
  "苏打",
  "白桦",
  "Mia",
  "Chloe",
  "Milo",
  "Dean",
] as const;

export const MIMO_TTS_DIALECTS = ["东北话", "四川话", "河南话", "粤语"] as const;
export const MIMO_TTS_PERSONA_TONES = ["夹子音", "御姐音", "正太音", "大叔音", "台湾腔"] as const;
export const MIMO_TTS_BASE_EMOTIONS = ["开心", "悲伤", "愤怒", "恐惧", "惊讶", "兴奋", "委屈", "平静", "冷漠"] as const;
export const MIMO_TTS_COMPOUND_EMOTIONS = ["怅然", "欣慰", "无奈", "愧疚", "释然", "嫉妒", "厌倦", "忐忑", "动情"] as const;
export const MIMO_TTS_OVERALL_TONES = ["温柔", "高冷", "活泼", "严肃", "慵懒", "俏皮", "深沉", "干练", "凌厉"] as const;
export const MIMO_TTS_VOICE_TEXTURES = ["磁性", "醇厚", "清亮", "空灵", "稚嫩", "苍老", "甜美", "沙哑", "醇雅"] as const;
export const MIMO_TTS_PACE_RHYTHMS = ["吸气", "深呼吸", "叹气", "长叹一口气", "喘息", "屏息"] as const;
export const MIMO_TTS_EMOTION_STATES = ["紧张", "害怕", "激动", "疲惫", "委屈", "撒娇", "心虚", "震惊", "不耐烦"] as const;
export const MIMO_TTS_VOICE_FEATURES = ["颤抖", "声音颤抖", "变调", "破音", "鼻音", "气声", "沙哑"] as const;
export const MIMO_TTS_LAUGH_CRY_EXPRESSIONS = ["笑", "轻笑", "大笑", "冷笑", "抽泣", "呜咽", "哽咽", "嚎啕大哭"] as const;

export function isMimoVoiceDesignModel(model: string): boolean {
  return model.trim() === MIMO_TTS_VOICE_DESIGN_MODEL;
}

export function isMimoVoiceCloneModel(model: string): boolean {
  return model.trim() === MIMO_TTS_VOICE_CLONE_MODEL;
}

export function supportsMimoSinging(model: string): boolean {
  return model.trim() === MIMO_TTS_MODEL;
}
