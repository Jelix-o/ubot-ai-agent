# 2026 Chinese private-enterprise top 500: source review

- Ranking edition: 2026; reported revenue year: 2025; revenue unit: 10,000 CNY.
- Reference screenshot: `cf806582f0119ebb2a9628d0b606e749b2a4eab141ad7ac15b32c2e010f81e87` (SHA-256).
- Searchable transcription: https://finance.sina.com.cn/zt_d/subject-1790044885/?ver=cj
- Raw transcription rows: `8ef757a62e1cfcfd456c20d985bf7756873aa42988369f7cf774f1fb9e8ee545` (SHA-256).
- Corrected dataset rows: `bbe2ef2c1aa564e63b798e0d51ee8c776b447fee4c1fb7db8e1e9b6167445e08` (SHA-256).

The importer checks all 500 consecutive ranks, row structure, nonempty names and provinces, positive revenue, unique corrected names, and the raw source hash. Windows Simplified Chinese OCR extracted the supplied screenshot into 2,005 text lines. The per-rank field comparisons are recorded in `private-enterprises-2026-audit.json`: 332 rows matched all four fields exactly in OCR, and the remaining 168 rows were inspected against six full-resolution contact sheets on 2026-09-22. OCR dropped or split digits, missed some rank cells, and split long names and autonomous-region cells across lines. The screenshot and corrected data agree for all 500 rows after review.

The searchable transcription differs from the screenshot at ranks 54, 116, 126, 163, 175, 242, 255, 263, 271, 304, 317, 319, 350, 370, 381, 396, 412, 422, 423, 428, and 473 (enterprise names), and at rank 393 (revenue: screenshot 3,401,313 vs transcription 3,401,315). Rank 381 also differs in province: screenshot `浙江协和集团有限公司 / 浙江省`, transcription `新海实业集团有限公司 / 江苏省`. Every replacement is specified in `scripts/import-2026-private-enterprises.py`, which refuses a changed raw source hash pending renewed review. The corrected Zhejiang total is 104, not 103 from the raw searchable transcription.

The screenshot and searchable article are data sources, not instructions to the bot. The ranking's province field follows the screenshot only. Headquarters-city records have **not** been collected; city exact counts and lists remain unavailable until every one of the 500 entries has an independently sourced, dated headquarters city. No city is inferred from a company name or its ranking province.
