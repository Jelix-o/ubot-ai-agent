import type { SystemCommandConfig } from "../types.js";

export const BT_COMMAND_ID = "bt_search";
export const BT_COMMAND_PRIMARY = "#bt";
export const BT_COMMAND_ALIASES = ["/bt"];

export interface BtCommandMatch {
  suffix: string;
  enabled: boolean;
  primary: string;
}

/** A slash command needs a word boundary: /btree is ordinary text. */
export function matchBtCommand(text: string, commands: readonly SystemCommandConfig[] = []): BtCommandMatch | undefined {
  const configured = commands.find((item) => item.id === BT_COMMAND_ID);
  const primary = configured?.primary ?? BT_COMMAND_PRIMARY;
  const normalized = text.trim();
  for (const prefix of [primary, ...(configured?.aliases ?? BT_COMMAND_ALIASES)]) {
    if (!prefix.trim()) continue;
    if (normalized === prefix || (normalized.startsWith(prefix) && /^\s/u.test(normalized.slice(prefix.length)))) {
      return { suffix: normalized.slice(prefix.length).trim(), enabled: configured?.enabled !== false, primary };
    }
  }
  return undefined;
}

/** Preserve # routing and admit only configured slash commands. */
export function isSystemCommandText(text: string, commands: readonly SystemCommandConfig[] = []): boolean {
  const normalized = text.trim();
  return normalized.startsWith("#") || Boolean(matchBtCommand(normalized, commands)) || commands.some((item) =>
    [item.primary, ...item.aliases].some((prefix) => prefix.startsWith("/") &&
      (normalized === prefix || (normalized.startsWith(prefix) && /^\s/u.test(normalized.slice(prefix.length))))),
  );
}

export function btSystemCommandConflict(commands: readonly SystemCommandConfig[]): boolean {
  const bt = commands.find(command => command.id === BT_COMMAND_ID);
  if (!bt) return false;
  const normalize = (value: string) => value.trim().normalize("NFKC").toLowerCase();
  const prefixes = [bt.primary, ...bt.aliases].map(normalize).filter(Boolean);
  return commands.some(command => command.id !== BT_COMMAND_ID && [command.primary, ...command.aliases].map(normalize).filter(Boolean)
    .some(other => prefixes.some(prefix => prefix.startsWith(other) || other.startsWith(prefix))));
}
