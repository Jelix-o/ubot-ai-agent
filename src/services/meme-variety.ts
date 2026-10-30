import type { MemeAsset } from "./meme-library-service.js";

export interface MemeUse { sha256: string; packId: string; assetId: string }

const ALIASES: Record<string, string[]> = {
  happy: ["开心", "高兴", "快乐"], angry: ["生气", "愤怒"], sad: ["难过", "伤心", "委屈"],
  confused: ["疑惑", "困惑", "懵"], surprised: ["惊讶", "震惊"], shy: ["害羞"],
  sleep: ["睡觉", "困了", "晚安"], affection: ["喜欢", "贴贴", "爱心"], food: ["吃饭", "吃的", "饿了"],
  money: ["钱", "金钱"], greeting: ["问候", "你好", "早安"], work: ["工作", "摸鱼", "上班"],
  entertainment: ["娱乐", "玩耍"], teasing: ["调侃", "吐槽"], reply: ["回应", "接话"],
  tech: ["科技", "技术"], portrait: ["肖像", "头像"],
};

/** Exact administrator labels take precedence over the built-in aliases. */
export function resolveMemeCategory<T extends { id: string; name: string }>(tags: T[], selector: string): T | undefined {
  const key = selector.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  const exact = tags.find(t => t.id === selector || t.name.normalize("NFKC").toLocaleLowerCase("zh-CN") === key);
  if (exact) return exact;
  const name = Object.keys(ALIASES).find(name => ALIASES[name]!.includes(key));
  return name ? tags.find(t => t.name.toLowerCase() === name) : undefined;
}

export function memeCategoryLabel(name: string): string {
  return ALIASES[name]?.[0] ? `${ALIASES[name]![0]}（${name}）` : name;
}
export function suggestMemeCategories(tags:Array<{name:string}>,selector:string):string[] {
  const key=selector.normalize("NFKC").trim().toLowerCase().slice(0,80);
  const distance=(name:string)=>{
    const value=name.toLowerCase().slice(0,80);
    if(key && (value.startsWith(key)||key.startsWith(value)))return Math.abs(value.length-key.length)/10;
    let row=Array.from({length:value.length+1},(_,i)=>i);
    for(let i=0;i<key.length;i++){const next=[i+1];for(let j=0;j<value.length;j++)next[j+1]=Math.min(next[j]!+1,row[j+1]!+1,row[j]!+Number(key[i]!==value[j]));row=next;}
    return row[value.length]!;
  };
  return tags.map(t=>({name:t.name,score:Math.min(...[t.name,...(ALIASES[t.name]??[])].map(distance))})).sort((a,b)=>a.score-b.score||a.name.localeCompare(b.name)).slice(0,3).map(t=>t.name);
}

/** Prefer unused content, then the least recently used pack within this category. */
export function pickVariedMeme(assets: MemeAsset[], recent: MemeUse[], random: () => number): MemeAsset | undefined {
  const unique = [...new Map(assets.map(a => [a.sha256, a])).values()];
  if (!unique.length) return undefined;
  const history = recent.slice(-10);
  let candidates: MemeAsset[] = [];
  for (let start = 0; start <= history.length; start++) {
    const excluded = new Set(history.slice(start).map(h => h.sha256));
    candidates = unique.filter(a => !excluded.has(a.sha256));
    if (candidates.length) break;
  }
  const usage = (pack: string) => history.filter(h => h.packId === pack).length;
  const min = Math.min(...candidates.map(a => usage(a.packId ?? "local")));
  const packs = [...new Set(candidates.filter(a => usage(a.packId ?? "local") === min).map(a => a.packId ?? "local"))];
  const index = (length: number) => Math.min(length - 1, Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * length));
  const pack = packs[index(packs.length)];
  const pool = candidates.filter(a => (a.packId ?? "local") === pack);
  return pool[index(pool.length)];
}

export function appendMemeUse(history: MemeUse[], asset: MemeAsset): MemeUse[] {
  return [...history, { sha256: asset.sha256, packId: asset.packId ?? "local", assetId: asset.id }].slice(-10);
}
