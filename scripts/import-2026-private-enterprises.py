#!/usr/bin/env python3
"""Import the published 2026 ranking table into a reviewed, versioned asset.

Requires only Python's standard library. The screenshot is the reference for
visual spot checks; the searchable HTML table supplies machine-readable rows.
"""

import hashlib
import json
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import Request, urlopen


SOURCE_URL = "https://finance.sina.com.cn/zt_d/subject-1790044885/?ver=cj"
SCREENSHOT_SHA256 = "cf806582f0119ebb2a9628d0b606e749b2a4eab141ad7ac15b32c2e010f81e87"
SOURCE_ROWS_SHA256 = "8ef757a62e1cfcfd456c20d985bf7756873aa42988369f7cf774f1fb9e8ee545"
OUTPUT = Path(__file__).resolve().parent.parent / "assets" / "private-enterprises-2026.json"

# The searchable transcription contains these errors. Each replacement was
# checked against the same-ranked row in the supplied full-page screenshot.
SCREENSHOT_CORRECTIONS = {
    54: ("弘润石化（潍坊）有限责任公司", "山东省", 16114941),
    116: ("贝壳控股有限公司", "北京市", 9458021),
    126: ("中天控股集团有限公司", "浙江省", 8503163),
    163: ("山东东方华龙工贸集团有限公司", "山东省", 7100136),
    175: ("三花控股集团有限公司", "浙江省", 6670500),
    242: ("湖南五江控股集团有限公司", "湖南省", 5068621),
    255: ("四川冶控集团有限公司", "四川省", 4844788),
    263: ("江苏满运软件科技有限公司", "江苏省", 4700648),
    271: ("江苏江润铜业有限公司", "江苏省", 4551868),
    304: ("河北新武安钢铁集团鑫汇冶金有限公司", "河北省", 4095852),
    317: ("河北文丰实业集团有限公司", "河北省", 3995651),
    319: ("南通化工轻工股份有限公司", "江苏省", 3964540),
    350: ("成都蛟龙港（成都蛟龙投资有限责任公司、成都蛟龙经济开发有限公司）", "四川省", 3709915),
    370: ("福建晟育投资发展集团有限公司", "福建省", 3565859),
    381: ("浙江协和集团有限公司", "浙江省", 3497839),
    393: ("江苏瑞祥科技集团有限公司", "江苏省", 3401313),
    396: ("东营市亚通石化有限公司", "山东省", 3342689),
    412: ("溧阳中联金电子商务有限公司", "江苏省", 3209351),
    422: ("联峰钢铁（张家港）有限公司", "江苏省", 3109135),
    423: ("湖北鑫资再生资源集团有限公司", "湖北省", 3103773),
    428: ("一柏集团有限公司", "福建省", 3080643),
    473: ("江苏盈泰供应链集团有限公司", "江苏省", 2774388),
}


class RankingTable(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_table = False
        self.in_cell = False
        self.cell_text = []
        self.row = []
        self.rows = []

    def handle_starttag(self, tag, attrs):
        if tag == "table" and dict(attrs).get("id") == "datalist":
            self.in_table = True
        elif self.in_table and tag == "tr":
            self.row = []
        elif self.in_table and tag == "td":
            self.in_cell = True
            self.cell_text = []

    def handle_data(self, data):
        if self.in_cell:
            self.cell_text.append(data)

    def handle_endtag(self, tag):
        if self.in_table and tag == "td":
            self.row.append("".join(self.cell_text).strip())
            self.in_cell = False
        elif self.in_table and tag == "tr" and self.row:
            self.rows.append(self.row)
        elif self.in_table and tag == "table":
            self.in_table = False


def main():
    with urlopen(Request(SOURCE_URL, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as response:
        page = response.read().decode("utf-8")
    parser = RankingTable()
    parser.feed(page)
    if len(parser.rows) != 500:
        raise ValueError(f"Expected 500 rows, got {len(parser.rows)}")

    entries = []
    source_entries = []
    names = set()
    for expected_rank, columns in enumerate(parser.rows, 1):
        if len(columns) != 4:
            raise ValueError(f"Rank {expected_rank}: expected four columns, got {columns!r}")
        rank, name, province, revenue = columns
        if int(rank) != expected_rank or not name or not province or not revenue.isdecimal():
            raise ValueError(f"Invalid row {expected_rank}: {columns!r}")
        source_entry = (name, province, int(revenue))
        source_entries.append({"rank": expected_rank, "name": name, "province": province, "revenueWan": int(revenue)})
        corrected = SCREENSHOT_CORRECTIONS.get(expected_rank, source_entry)
        if corrected != source_entry and (corrected[1], corrected[2]) != source_entry[1:]:
            if expected_rank not in (381, 393):
                raise ValueError(f"Unexpected transcription mismatch at rank {expected_rank}")
        if corrected[0] in names:
            raise ValueError(f"Duplicate enterprise: {corrected[0]}")
        names.add(corrected[0])
        entries.append({"rank": expected_rank, "name": corrected[0], "province": corrected[1], "revenueWan": corrected[2]})

    source_canonical = json.dumps(source_entries, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if hashlib.sha256(source_canonical).hexdigest() != SOURCE_ROWS_SHA256:
        raise ValueError("Searchable source has changed; review every correction again")

    # These anchors were inspected in the supplied full-page screenshot.
    anchors = {
        1: ("京东集团", "北京市", 130908500),
        2: ("阿里巴巴（中国）有限公司", "浙江省", 101674400),
        3: ("恒力集团有限公司", "江苏省", 89906901),
        500: ("玲珑集团有限公司", "山东省", 2559930),
    }
    for rank, expected in anchors.items():
        entry = entries[rank - 1]
        if (entry["name"], entry["province"], entry["revenueWan"]) != expected:
            raise ValueError(f"Screenshot anchor {rank} did not match")

    canonical = json.dumps(entries, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    result = {
        "edition": 2026,
        "revenueYear": 2025,
        "publishedOn": "2026-09-22",
        "rankingSource": SOURCE_URL,
        "transcriptionRowsSha256": SOURCE_ROWS_SHA256,
        "screenshotSha256": SCREENSHOT_SHA256,
        "rowsSha256": hashlib.sha256(canonical).hexdigest(),
        "screenshotCheckedRanks": list(range(1, 501)),
        "screenshotSpotCheckedRanks": list(anchors),
        "screenshotCorrections": list(SCREENSHOT_CORRECTIONS),
        "headquartersBasis": "published-date headquarters; independently sourced, not inferred from ranking province",
        "entries": entries,
    }
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(entries)} rows to {OUTPUT}; SHA-256: {result['rowsSha256']}")


if __name__ == "__main__":
    main()
