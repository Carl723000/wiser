"""Actual synthetic DOCX ZIP/XML bytes, never a converter or SQL substitute."""
import io
import json
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest
import zipfile

from word_structure import WordStructureError, extract_word_structure

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def paragraph(text):
    return f'<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def cell(text, properties="", nested=""):
    return f'<w:tc><w:tcPr>{properties}</w:tcPr>{paragraph(text)}{nested}</w:tc>'


def table(rows, grid="4800,4800", width="9600"):
    columns = "".join(f'<w:gridCol w:w="{w}"/>' for w in grid.split(","))
    return f'<w:tbl><w:tblPr><w:tblW w:type="dxa" w:w="{width}"/></w:tblPr><w:tblGrid>{columns}</w:tblGrid>{rows}</w:tbl>'


def docx(body, stories=None, prolog=""):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml", f'{prolog}<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>')
        for name, xml in (stories or {}).items():
            archive.writestr(name, xml)
    return output.getvalue()


class FullWordStructureTest(unittest.TestCase):
    def test_retains_full_width_grid_offsets_spans_merges_empty_cells_and_all_stories(self):
        props = '<w:tcW w:type="dxa" w:w="9600"/><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/>'
        row1 = '<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>'+cell("潮白河", props)+cell("Ⅱ")+'</w:tr>'
        row2 = '<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>'+cell("", '<w:gridSpan w:val="2"/><w:vMerge/>')+cell("0")+'</w:tr>'
        body = paragraph("2023年4月地表水报告")+table(row1+row2, "2400,2400,2400,2400")
        stories = {"word/header1.xml": f'<w:hdr xmlns:w="{W}">{paragraph("2023年4月")}</w:hdr>',
                   "word/footer1.xml": f'<w:ftr xmlns:w="{W}">{paragraph("页脚")}</w:ftr>',
                   "word/footnotes.xml": f'<w:footnotes xmlns:w="{W}"><w:footnote w:id="1">{paragraph("")}</w:footnote></w:footnotes>'}
        value = extract_word_structure(docx(body, stories))
        self.assertEqual(set(value), {"tables", "paragraphs", "monthTitles"})
        self.assertEqual(len(value["tables"]), 1)
        physical = value["tables"][0]
        self.assertEqual(physical["locator"], "word/document.xml#table:1")
        self.assertEqual(physical["width"], {"type": "dxa", "value": "9600"})
        self.assertEqual(physical["gridWidths"], ["2400"]*4)
        self.assertEqual([len(row["cells"]) for row in physical["rows"]], [2, 2])
        first, empty = physical["rows"][0]["cells"][0], physical["rows"][1]["cells"][0]
        self.assertEqual((first["column"], first["columnSpan"], first["verticalMerge"]), (2, 2, "restart"))
        self.assertEqual(first["width"], {"type": "dxa", "value": "9600"})
        self.assertEqual(empty["text"], "")
        self.assertEqual(empty["verticalMerge"], "continue")
        self.assertEqual(empty["locator"], "word/document.xml#table:1/row:2/cell:1")
        self.assertEqual([p["text"] for p in value["paragraphs"]], ["2023年4月地表水报告", "潮白河", "Ⅱ", "", "0", "页脚", "", "2023年4月"])
        self.assertEqual([p["text"] for p in value["monthTitles"]], ["2023年4月地表水报告", "2023年4月"])

    def test_nested_tables_remain_physical_tables_and_no_text_is_trimmed(self):
        nested = table('<w:tr>'+cell(" Inner ")+'</w:tr>', "1200", "1200")
        body = table('<w:tr>'+cell(" Outer ", nested=nested)+cell("")+'</w:tr>')
        value = extract_word_structure(docx(body))
        self.assertEqual(len(value["tables"]), 2)
        self.assertEqual(value["tables"][1]["locator"], "word/document.xml#table:2")
        self.assertEqual(value["tables"][1]["rows"][0]["cells"][0]["text"], " Inner ")
        self.assertEqual([p["text"] for p in value["paragraphs"]], [" Outer ", " Inner ", ""])

    def test_tabs_line_breaks_and_distinct_empty_paragraphs_are_preserved(self):
        text = '<w:p><w:r><w:t xml:space="preserve"> A </w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>'
        body = table('<w:tr><w:tc>'+text+paragraph("")+'</w:tc>'+cell("")+'</w:tr>')
        value = extract_word_structure(docx(body))
        self.assertEqual(value["tables"][0]["rows"][0]["cells"][0]["text"], " A \tB\nC\n")

    def test_rejects_unsupported_legacy_merge_without_partial_structure(self):
        body = table('<w:tr>'+cell("keep", '<w:hMerge/>')+cell("")+'</w:tr>')
        with self.assertRaises(WordStructureError) as caught:
            extract_word_structure(docx(body))
        self.assertEqual(caught.exception.reason, "INVALID_STRUCTURE")

    def test_rejects_dtd_entity_non_word_xml_and_input_budget(self):
        for content in [b"not a DOCX", docx(paragraph("&x;"), prolog='<!DOCTYPE x [<!ENTITY x "expanded">]>')]:
            with self.assertRaises(WordStructureError) as caught:
                extract_word_structure(content)
            self.assertEqual(caught.exception.reason, "INVALID_STRUCTURE")
        content = docx(paragraph("unchanged"))
        with self.assertRaises(WordStructureError) as caught:
            extract_word_structure(content, maximum_bytes=len(content)-1)
        self.assertEqual(caught.exception.reason, "BUDGET_EXCEEDED")

    def test_private_cli_reads_actual_bytes_and_emits_only_the_strict_envelope(self):
        content = docx(paragraph("2023年4月")+table('<w:tr>'+cell("")+cell("0")+'</w:tr>'))
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)/"source.docx"
            source.write_bytes(content)
            command = [sys.executable, str(Path(__file__).with_name("word_structure.py")), str(source), str(len(content))]
            process = subprocess.run(command, capture_output=True, timeout=5, check=True)
            response = json.loads(process.stdout)
            self.assertEqual(response, {"kind": "STRUCTURE", "structure": extract_word_structure(content)})
            self.assertEqual(process.stderr, b"")
            source.write_bytes(b"invalid DOCX")
            response = json.loads(subprocess.run(command, capture_output=True, timeout=5, check=True).stdout)
            self.assertEqual(response, {"kind": "UNVERIFIABLE", "reason": "INVALID_STRUCTURE"})

    def test_rejects_unsafe_archive_and_excessive_xml_depth_instead_of_omitting_content(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("../unexpected.xml", "outside")
            archive.writestr("word/document.xml", "unused")
        with self.assertRaises(WordStructureError) as caught:
            extract_word_structure(output.getvalue())
        self.assertEqual(caught.exception.reason, "INVALID_STRUCTURE")
        body = "<w:p>" + "<w:r>"*130 + "<w:t>deep</w:t>" + "</w:r>"*130 + "</w:p>"
        with self.assertRaises(WordStructureError) as caught:
            extract_word_structure(docx(body))
        self.assertEqual(caught.exception.reason, "BUDGET_EXCEEDED")


if __name__ == "__main__":
    unittest.main()
