/** CQ values must be escaped even though normal OneBot message ids are numeric. */
export function withReplyReference(text: string, messageId?: string): string {
  if (!messageId?.trim()) return text;
  const id = messageId.trim().replace(/&/g, "&amp;").replace(/\[/g, "&#91;").replace(/\]/g, "&#93;").replace(/,/g, "&#44;");
  return `[CQ:reply,id=${id}]${text}`;
}
