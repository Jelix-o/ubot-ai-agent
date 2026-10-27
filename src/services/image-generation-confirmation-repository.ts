import type { SharedDb } from "../shared/sqlite.js";

/** Stores source associations only; prompt and identities stay in ingress. */
export class ImageGenerationConfirmationRepository {
  constructor(private readonly shared: SharedDb) {}

  request(sourceRowId: number, now = Date.now()): void {
    this.shared.db.prepare(`INSERT OR IGNORE INTO image_generation_confirmations (source_row_id, expires_at) VALUES (?, ?)`)
      .run(sourceRowId, now + 120_000);
  }

  confirm(sourceRowId: number, now = Date.now()): number | undefined {
    const db = this.shared.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare("SELECT source_row_id FROM image_generation_confirmations WHERE confirmed_source_row_id = ?")
        .get(sourceRowId) as { source_row_id: number } | undefined;
      if (existing) { db.exec("COMMIT"); return existing.source_row_id; }
      const pending = db.prepare(`SELECT c.* FROM image_generation_confirmations c
        JOIN messages original ON original.id = c.source_row_id
        JOIN messages confirmation ON confirmation.id = ?
        WHERE original.group_id = confirmation.group_id AND original.user_id = confirmation.user_id
          AND original.id < confirmation.id ORDER BY original.id DESC LIMIT 1`)
        .get(sourceRowId) as { source_row_id: number; confirmed_source_row_id: number | null; expires_at: number } | undefined;
      let result: number | undefined;
      if (pending && pending.confirmed_source_row_id === null && pending.expires_at > now) {
        db.prepare("UPDATE image_generation_confirmations SET confirmed_source_row_id = ? WHERE source_row_id = ?")
          .run(sourceRowId, pending.source_row_id);
        result = pending.source_row_id;
      }
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}
