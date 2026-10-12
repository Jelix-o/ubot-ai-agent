import type { ForwardAutoRecallOptions, MessageReceipt, MessageTransport } from "./bot.js";
import { NapCatActionRejectedError } from "./napcat-action-errors.js";

export interface ForwardMessageNode {
  senderId: string;
  senderName: string;
  text: string;
}

export interface ForwardDeliveryResult {
  /** `forward` means the card itself was accepted by NapCat; `fallback` means only fallback text was sent. */
  kind: "forward" | "fallback";
  receipt: void | MessageReceipt;
}

export const BT_FORWARD_FALLBACK_TEXT = "【BT 搜索】\n合并转发暂不可用，请稍后重新搜索。";

/** Forward content is literal text, never a CQ-code string. */
export function toNapCatForwardNodes(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error("Invalid forward nodes");
  return value.map((node: ForwardMessageNode) => {
    if (!node || typeof node.senderId !== "string" || !/^\d+$/u.test(node.senderId) ||
      !Number.isSafeInteger(Number(node.senderId)) || Number(node.senderId) <= 0 ||
      typeof node.senderName !== "string" || !node.senderName.trim() ||
      typeof node.text !== "string" || !node.text) throw new Error("Invalid forward node");
    return { type: "node" as const, data: {
      user_id: Number(node.senderId), nickname: node.senderName,
      content: [{ type: "text" as const, data: { text: node.text } }],
    } };
  });
}

export function serializeForwardNodes(nodes: ForwardMessageNode[]): string {
  toNapCatForwardNodes(nodes);
  const json = JSON.stringify(nodes);
  if (Buffer.byteLength(json) > 1024 * 1024) throw new Error("Forward payload is too large");
  return json;
}

export function parseForwardNodes(json: string | null | undefined): ForwardMessageNode[] {
  if (!json || Buffer.byteLength(json) > 1024 * 1024) throw new Error("Invalid forward payload");
  const nodes: unknown = JSON.parse(json);
  toNapCatForwardNodes(nodes);
  return nodes as ForwardMessageNode[];
}

/** Never fall back after an ambiguous send, which could create a duplicate. */
export async function sendForwardOrFallback(
  transport: MessageTransport,
  groupId: string,
  nodes: ForwardMessageNode[],
  fallbackText: string,
  options?: ForwardAutoRecallOptions,
): Promise<ForwardDeliveryResult> {
  if (!transport.sendGroupForwardMessage) {
    return { kind: "fallback", receipt: await transport.sendGroupMessage(groupId, fallbackText) };
  }
  try {
    return { kind: "forward", receipt: await transport.sendGroupForwardMessage(groupId, nodes, options) };
  }
  catch (error) {
    if (!(error instanceof NapCatActionRejectedError)) throw error;
    return { kind: "fallback", receipt: await transport.sendGroupMessage(groupId, fallbackText) };
  }
}
