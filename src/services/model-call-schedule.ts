export const MODEL_CALL_TIMEZONE = "Asia/Shanghai";

/** This task intentionally supports one daily Beijing slot, independent of host TZ. */
export function nextModelCallAt(time: string, after = new Date()): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("invalid_model_call_time");
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const day = new Date(after.getTime() + 8 * 3600_000);
  let candidate = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour - 8, minute);
  if (candidate <= after.getTime()) candidate += 24 * 3600_000;
  return new Date(candidate).toISOString();
}
