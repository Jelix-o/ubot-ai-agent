/** Only explicit requests for existing stickers; creative image requests remain in the image pipeline. */
export function naturalMemeSelector(text: string, hasAtBot: boolean): string | undefined {
    if (!hasAtBot)
        return;
    const value = text.trim().replace(/[。！!？?]+$/u, "");
    if (/^(?:请|帮我|给我)?(?:再换|换|再来)(?:一)?张(?:表情(?:包)?)?$/u.test(value))
        return "换一张";
    const match = /^(?:请|帮我|请帮我)?(?:来|发|给我|整)(?:一)?(?:张|个)?\s*(.*?)\s*(?:的)?表情(?:包)?(?:给我)?$/u.exec(value);
    if (match)
        return match[1]!.replace(/的$/u, "").trim() || "分类";
}
