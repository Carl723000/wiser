import tempfile
import unittest
import zipfile
from pathlib import Path
from parser import parse_asset


def cell(text='', properties=''):
    return f'<w:tc><w:tcPr>{properties}</w:tcPr><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:tc>'


class WordTableTest(unittest.TestCase):
    def parse(self, body):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'source.docx'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'</w:body></w:document>')
            return list(parse_asset(path, 'docx'))

    def rows(self, events):
        return [e['values']['c3'] for e in events if e['type']=='record' and e['values'].get('c3')]

    def test_preserves_physical_cells_and_merge_markers_without_filling(self):
        events = self.parse('<w:p><w:r><w:t>2024年4月</w:t></w:r></w:p><w:tbl><w:tr>'+cell('永定河','<w:vMerge w:val="restart"/>')+cell('Ⅱ','<w:gridSpan w:val="2"/>')+'</w:tr><w:tr>'+cell('','<w:vMerge/>')+cell('无水')+cell('0')+'</w:tr></w:tbl>')
        rows=self.rows(events)
        self.assertEqual(len(rows),2)
        self.assertEqual(rows[0]['cells'][0]['verticalMerge'],'restart')
        self.assertEqual(rows[0]['cells'][1]['columnSpan'],2)
        self.assertEqual(rows[1]['cells'][0]['verticalMerge'],'continue')
        self.assertEqual([c['text'] for c in rows[1]['cells']],['','无水','0'])
        self.assertEqual([c['column'] for c in rows[1]['cells']],[1,2,3])
        self.assertEqual(rows[1]['rowIndex'],2)
        self.assertEqual(rows[0]['sourcePart'],'word/document.xml')
        original=[e['values'] for e in events if e['type']=='record' and not e['values'].get('c3')]
        self.assertEqual(original[0],{'c1':'2024年4月','c2':'word/document.xml#paragraph:1'})
        self.assertEqual(events[-1]['featureCount'],0)

    def test_nested_tables_remain_text_and_report_unresolved_structure(self):
        events=self.parse('<w:tbl><w:tr><w:tc><w:tbl><w:tr>'+cell('Nested')+'</w:tr></w:tbl></w:tc></w:tr></w:tbl>')
        self.assertEqual(self.rows(events),[])
        self.assertEqual(events[-1]['status'],'PARTIAL')
        self.assertIn('Nested',str(events))

    def test_invalid_span_does_not_guess_columns(self):
        events=self.parse('<w:tbl><w:tr>'+cell('Keep','<w:gridSpan w:val="-1"/>')+'</w:tr></w:tbl>')
        self.assertEqual(self.rows(events),[])
        self.assertEqual(events[-1]['status'],'PARTIAL')

    def test_bookmarks_and_row_style_overrides_do_not_hide_physical_rows(self):
        events=self.parse('<w:tbl><w:bookmarkStart w:id="0"/><w:tr><w:tblPrEx/>'+cell('Ⅱ')+'</w:tr><w:bookmarkEnd w:id="0"/></w:tbl>')
        self.assertEqual(self.rows(events)[0]['cells'][0]['text'],'Ⅱ')
        self.assertEqual(events[-1]['status'],'READY')


if __name__=='__main__':
    unittest.main()
