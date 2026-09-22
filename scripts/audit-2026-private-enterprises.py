#!/usr/bin/env python3
"""Compare a Windows OCR pass over the supplied screenshot with every ranking row."""

import argparse
import hashlib
import json
import unicodedata
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "assets" / "private-enterprises-2026.json"


def normalized(value):
    return "".join(
        char for char in unicodedata.normalize("NFKC", value)
        if not char.isspace() and not unicodedata.category(char).startswith("P")
    )


def nearest(lines, x_min, x_max, y, tolerance=17):
    matches = [line for line in lines if x_min <= line["x"] < x_max and abs(line["y"] - y) <= tolerance]
    return min(matches, key=lambda line: abs(line["y"] - y))["text"] if matches else ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("ocr", type=Path)
    parser.add_argument("screenshot", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "assets" / "private-enterprises-2026-audit.json")
    parser.add_argument("--contact-dir", type=Path)
    args = parser.parse_args()

    data = json.loads(DATA.read_text(encoding="utf-8"))
    checksum = hashlib.sha256(args.screenshot.read_bytes()).hexdigest()
    if checksum != data["screenshotSha256"]:
        raise ValueError("Screenshot SHA-256 differs from the versioned ranking asset")
    lines = json.loads(args.ocr.read_text(encoding="utf-8-sig"))
    ranks = {}
    for line in lines:
        if 630 <= line["x"] < 705 and line["text"].isdigit():
            rank = int(line["text"])
            if 1 <= rank <= 500:
                ranks.setdefault(rank, line["y"])

    records = []
    for entry in data["entries"]:
        rank = entry["rank"]
        y = ranks.get(rank)
        name = nearest(lines, 705, 1200, y) if y is not None else ""
        province = nearest(lines, 1200, 1320, y) if y is not None else ""
        revenue = nearest(lines, 1320, 1490, y) if y is not None else ""
        checks = {
            "rank": y is not None,
            "name": normalized(name) == normalized(entry["name"]),
            "province": normalized(province) == normalized(entry["province"]),
            "revenueWan": normalized(revenue) == str(entry["revenueWan"]),
        }
        records.append({
            "rank": rank,
            "screenshotY": y,
            "ocr": {"name": name, "province": province, "revenueWan": revenue},
            "checks": checks,
        })

    counts = {field: sum(record["checks"][field] for record in records) for field in ("rank", "name", "province", "revenueWan")}
    exact = sum(all(record["checks"].values()) for record in records)
    audit = {
        "screenshotSha256": checksum,
        "rankingRowsSha256": data["rowsSha256"],
        "method": "Windows Simplified Chinese OCR; each rank and field compared with the searchable table; OCR mismatches require manual review",
        "ocrExactRows": exact,
        "fieldMatches": counts,
        "records": records,
    }
    args.output.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.contact_dir:
        from PIL import Image, ImageDraw, ImageFont

        args.contact_dir.mkdir(parents=True, exist_ok=True)
        source = Image.open(args.screenshot)
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 18)
        review = [record for record in records if not all(record["checks"].values())]
        for sheet_number, offset in enumerate(range(0, len(review), 30), 1):
            page = review[offset:offset + 30]
            sheet = Image.new("RGB", (1700, len(page) * 66), "white")
            draw = ImageDraw.Draw(sheet)
            for row_index, record in enumerate(page):
                rank = record["rank"]
                y = record["screenshotY"]
                if y is None:
                    before = next((records[index - 1]["screenshotY"] for index in range(rank - 1, 0, -1)
                                   if records[index - 1]["screenshotY"] is not None), None)
                    after = next((records[index - 1]["screenshotY"] for index in range(rank + 1, 501)
                                  if records[index - 1]["screenshotY"] is not None), None)
                    before_rank = next((index for index in range(rank - 1, 0, -1)
                                        if records[index - 1]["screenshotY"] is not None), None)
                    after_rank = next((index for index in range(rank + 1, 501)
                                       if records[index - 1]["screenshotY"] is not None), None)
                    if before is not None and after is not None:
                        y = before + (after - before) * (rank - before_rank) / (after_rank - before_rank)
                if y is not None:
                    top = max(0, int(y) - 17)
                    sheet.paste(source.crop((625, top, 1515, top + 56)), (0, row_index * 66))
                entry = data["entries"][rank - 1]
                expected = f'{rank} {entry["name"]} {entry["province"]} {entry["revenueWan"]}'
                draw.text((910, row_index * 66 + 8), expected, fill="black", font=font)
            sheet.save(args.contact_dir / f"review-{sheet_number:02}.png")
    print(f"Exact OCR rows: {exact}/500; field matches: {counts}")
    print("Needs review:", [record["rank"] for record in records if not all(record["checks"].values())])


if __name__ == "__main__":
    main()
