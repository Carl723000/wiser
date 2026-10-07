"""Private full physical OOXML reader; never emits partial record extraction."""
import io
import json
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath
from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_STRUCTURE_BYTES = 16 * 1024 * 1024
MAX_NODES = 300_000
WORD_NAMESPACES = {
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
}
MONTH_TITLE = re.compile(
    r"(?<!\d)(?:19|20)\d{2}\s*(?:年\s*(?:0?[1-9]|1[0-2])\s*月"
    r"|[-/.]\s*(?:0?[1-9]|1[0-2])(?!\d))"
)
STORY = re.compile(r"word/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml\Z")


class WordStructureError(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def bounded(value, minimum, maximum):
    if not minimum <= value <= maximum:
        raise WordStructureError("BUDGET_EXCEEDED")
    return value


def string(value, maximum, nonempty=False):
    if not isinstance(value, str) or (nonempty and not value):
        raise WordStructureError("INVALID_STRUCTURE")
    bounded(len(value.encode("utf-16-le")) // 2, 0, maximum)
    return value


def archive_guard(archive):
    # Same inert ZIP limits as parser.safe_archive, without importing PDF/GDAL.
    entries = archive.infolist()
    bounded(len(entries), 0, 4096)
    bounded(sum(entry.file_size for entry in entries), 0, MAX_EXPANDED_BYTES)
    seen = set()
    for entry in entries:
        name = entry.orig_filename
        if (not name or len(name) > 1024 or "\\" in name or "\0" in name
                or name.startswith("/") or ".." in PurePosixPath(name).parts
                or re.match(r"^[a-zA-Z]:", name) or name in seen
                or stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1):
            raise WordStructureError("INVALID_STRUCTURE")
        if entry.file_size > max(1, entry.compress_size) * 1000:
            raise WordStructureError("BUDGET_EXCEEDED")
        seen.add(name)


def owned_children(element, target, stops):
    """Find physical children inside inert wrappers, stopping at nested owners."""
    for child in element:
        if child.tag == target:
            yield child
        elif child.tag not in stops:
            yield from owned_children(child, target, stops)


def paragraph_text(paragraph, w):
    def fragments(element):
        for child in element:
            if child.tag == w + "p":
                continue  # Textbox paragraphs get their own stable locator.
            if child.tag == w + "t":
                yield child.text or ""
            elif child.tag == w + "tab":
                yield "\t"
            elif child.tag in (w + "br", w + "cr"):
                yield "\n"
            elif child.tag == w + "noBreakHyphen":
                yield "\u2011"
            elif child.tag == w + "softHyphen":
                yield "\u00ad"
            else:
                yield from fragments(child)
    return string("".join(fragments(paragraph)), 262_144)


def width(properties, name, w):
    node = properties.find(w + name) if properties is not None else None
    if node is None:
        return None
    return {
        "type": string(node.get(w + "type"), 16, True),
        "value": string(node.get(w + "w"), 32),
    }


def integer_property(properties, name, default, w, minimum=0):
    node = properties.find(w + name) if properties is not None else None
    if node is None:
        return default
    raw = node.get(w + "val")
    if raw is None or not re.fullmatch(r"\d+", raw):
        raise WordStructureError("INVALID_STRUCTURE")
    return bounded(int(raw), minimum, 1024)


def physical_table(table, locator, w):
    grids = table.findall(w + "tblGrid")
    if len(grids) > 1:
        raise WordStructureError("INVALID_STRUCTURE")
    grid = (
        [string(node.get(w + "w"), 32) for node in grids[0].findall(w + "gridCol")]
        if grids else []
    )
    bounded(len(grid), 0, 1024)
    rows = []
    for row_index, tr in enumerate(owned_children(table, w + "tr", {w + "tbl"}), 1):
        bounded(row_index, 1, 10_000)
        row_locator = f"{locator}/row:{row_index}"
        properties = tr.find(w + "trPr")
        column = 1 + integer_property(properties, "gridBefore", 0, w)
        after = integer_property(properties, "gridAfter", 0, w)
        cells = []
        for cell_index, tc in enumerate(owned_children(tr, w + "tc", {w + "tbl", w + "tr"}), 1):
            bounded(cell_index, 1, 1024)
            props = tc.find(w + "tcPr")
            span = integer_property(props, "gridSpan", 1, w, 1)
            bounded(column, 1, 1024)
            bounded(column + span - 1, 1, 1024)
            merge = props.find(w + "vMerge") if props is not None else None
            merge_value = (
                merge.get(w + "val", "continue") if merge is not None else None
            )
            if merge_value not in (None, "restart", "continue"):
                raise WordStructureError("INVALID_STRUCTURE")
            text = "\n".join(
                paragraph_text(p, w)
                for p in owned_children(tc, w + "p", {w + "tbl"})
            )
            cells.append({
                "locator": f"{row_locator}/cell:{cell_index}",
                "column": column,
                "columnSpan": span,
                "verticalMerge": merge_value,
                "width": width(props, "tcW", w),
                "text": string(text, 262_144),
            })
            column += span
        # No fabricated empty cells: only physical cells appear in the structure.
        if grid and column - 1 + after > len(grid):
            raise WordStructureError("INVALID_STRUCTURE")
        rows.append({"locator": row_locator, "cells": cells})
    return {
        "locator": locator,
        "width": width(table.find(w + "tblPr"), "tblW", w),
        "gridWidths": grid,
        "rows": rows,
    }


def structure_budget(value):
    count = 0
    def visit(item, depth):
        nonlocal count
        count += 1
        bounded(count, 0, MAX_NODES)
        bounded(depth, 0, 16)
        if isinstance(item, dict):
            for child in item.values():
                visit(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                visit(child, depth + 1)
    visit(value, 0)
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    bounded(len(encoded.encode("utf-8")), 0, MAX_STRUCTURE_BYTES)


def xml_budget(root):
    count = 0
    pending = [(root, 0)]
    while pending:
        element, depth = pending.pop()
        count += 1
        bounded(count, 1, MAX_NODES)
        bounded(depth, 0, 128)
        pending.extend((child, depth + 1) for child in element)


def extract_word_structure(content, maximum_bytes=MAX_INPUT_BYTES):
    bounded(maximum_bytes, 1, MAX_INPUT_BYTES)
    bounded(len(content), 1, maximum_bytes)
    result = {"tables": [], "paragraphs": [], "monthTitles": []}
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            archive_guard(archive)
            if "word/document.xml" not in archive.namelist():
                raise WordStructureError("INVALID_STRUCTURE")
            parts = ["word/document.xml"] + sorted(
                name for name in archive.namelist()
                if STORY.fullmatch(name) and name != "word/document.xml"
            )
            for part in parts:
                bounded(archive.getinfo(part).file_size, 1, MAX_INPUT_BYTES)
                with archive.open(part) as source:
                    root = ElementTree.parse(
                        source, forbid_dtd=True, forbid_entities=True,
                        forbid_external=True,
                    ).getroot()
                namespace = root.tag.partition("}")[0].removeprefix("{")
                if namespace not in WORD_NAMESPACES:
                    raise WordStructureError("INVALID_STRUCTURE")
                w = "{" + namespace + "}"
                expected = (
                    "document" if part == "word/document.xml"
                    else "hdr" if "/header" in part
                    else "ftr" if "/footer" in part
                    else Path(part).stem
                )
                if root.tag != w + expected or (part == "word/document.xml" and root.find(w + "body") is None):
                    raise WordStructureError("INVALID_STRUCTURE")
                xml_budget(root)
                # Unsupported constructs need semantics absent from this schema.
                unsupported = {
                    w + tag for tag in (
                        "hMerge", "altChunk", "sym", "del", "ins", "moveFrom", "moveTo",
                    )
                }
                unsupported.add("{http://schemas.openxmlformats.org/markup-compatibility/2006}AlternateContent")
                if any(node.tag in unsupported for node in root.iter()):
                    raise WordStructureError("INVALID_STRUCTURE")
                for index, table in enumerate(root.iter(w + "tbl"), 1):
                    result["tables"].append(
                        physical_table(table, f"{part}#table:{index}", w)
                    )
                    bounded(len(result["tables"]), 0, 10_000)
                for index, paragraph in enumerate(root.iter(w + "p"), 1):
                    entry = {
                        "locator": f"{part}#paragraph:{index}",
                        "text": paragraph_text(paragraph, w),
                    }
                    result["paragraphs"].append(entry)
                    bounded(len(result["paragraphs"]), 0, 100_000)
                    if MONTH_TITLE.search(entry["text"]):
                        result["monthTitles"].append(dict(entry))
        structure_budget(result)
        return result
    except (zipfile.BadZipFile, ElementTree.ParseError, DefusedXmlException, ValueError, NotImplementedError) as error:
        raise WordStructureError("INVALID_STRUCTURE") from error


def main():
    # Private file/JSON process port; legacy parser HTTP requests stay unchanged.
    try:
        if len(sys.argv) != 3:
            raise WordStructureError("INVALID_STRUCTURE")
        maximum = bounded(int(sys.argv[2]), 1, MAX_INPUT_BYTES)
        with open(sys.argv[1], "rb") as source:
            content = source.read(maximum + 1)
        value = {"kind": "STRUCTURE", "structure": extract_word_structure(content, maximum)}
    except WordStructureError as error:
        value = {"kind": "UNVERIFIABLE", "reason": error.reason}
    except (OSError, ValueError):
        value = {"kind": "UNVERIFIABLE", "reason": "TOOL_UNAVAILABLE"}
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
