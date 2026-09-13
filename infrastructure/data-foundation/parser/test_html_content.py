"""Table structure is source evidence, not a reconstructed observation dataset."""
import tempfile
import unittest
from pathlib import Path
from parser import parse_asset


class HtmlTableTest(unittest.TestCase):
    def parse(self, text):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'source.html'
            path.write_text(text, encoding='utf-8')
            return list(parse_asset(path, 'html'))

    def rows(self, events):
        return [event['values']['c3'] for event in events
                if event['type'] == 'record' and event['values'].get('c3')]

    def test_preserves_multirow_headers_units_spans_and_significance_as_source_text(self):
        events = self.parse('''<p>Study, not raw samples.</p><table id="t1"><caption>Table 1</caption>
        <thead><tr><th rowspan="2">Variable</th><th colspan="2">June</th><th colspan="2">August</th></tr>
        <tr><th>Mean</th><th>s.d.</th><th>Mean</th><th>s.d.</th></tr></thead>
        <tbody><tr><th>DO (mg/L)</th><td>8.55 <sup>b</sup></td><td>0.70</td><td>11.14 <sup>a</sup></td><td>3.44</td></tr></tbody></table>''')
        rows = self.rows(events)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]['tableId'], 't1')
        self.assertEqual(rows[0]['caption'], 'Table 1')
        self.assertEqual(rows[0]['cells'][0]['rowSpan'], 2)
        self.assertEqual(rows[0]['cells'][1]['columnSpan'], 2)
        self.assertEqual([cell['column'] for cell in rows[1]['cells']], [2, 3, 4, 5])
        self.assertEqual(rows[2]['cells'][1]['text'], '8.55 b')
        self.assertEqual(rows[2]['cells'][0]['text'], 'DO (mg/L)')
        self.assertEqual(rows[2]['section'], 'tbody')
        self.assertEqual(rows[2]['rowIndex'], 3)
        self.assertEqual(events[-1]['featureCount'], 0)

    def test_keeps_empty_cells_and_table_identity_without_executing_content(self):
        events = self.parse('<table><tr><td>001</td><td></td><td>0<script>doBad()</script></td></tr></table><table id="two"><tr><td>Other</td></tr></table>')
        rows = self.rows(events)
        self.assertEqual([row['tableIndex'] for row in rows], [1, 2])
        self.assertEqual([cell['text'] for cell in rows[0]['cells']], ['001', '', '0'])
        self.assertNotIn('doBad', str(events))
        self.assertEqual(events[-1]['status'], 'READY')

    def test_nested_or_unclosed_tables_are_explicitly_partial_not_guessed(self):
        for text in ['<table><tr><td>Outer<table><tr><td>Inner</td></tr></table></td></tr></table>', '<table><tr><td>Open']:
            with self.subTest(text=text):
                events = self.parse(text)
                self.assertEqual(self.rows(events), [])
                self.assertEqual(events[-1]['status'], 'PARTIAL')
                self.assertEqual(events[-1]['reason'], 'HTML_TABLE_STRUCTURE_UNRESOLVED')

    def test_absurd_spans_do_not_allocate_a_huge_grid(self):
        events = self.parse('<table><tr><td colspan="999999999">Preserve this text</td></tr></table>')
        self.assertEqual(self.rows(events), [])
        self.assertEqual(events[-1]['status'], 'PARTIAL')
        self.assertIn('Preserve this text', str(events))

    def test_large_identifiers_and_cell_budgets_keep_text_but_disclose_partial_structure(self):
        for text in ['<table id="' + 'x' * 513 + '"><tr><td>Text</td></tr></table>',
                     '<table><tr><td>' + 'a' * 16001 + '</td></tr></table>']:
            with self.subTest(size=len(text)):
                events = self.parse(text)
                self.assertEqual(self.rows(events), [])
                self.assertEqual(events[-1]['status'], 'PARTIAL')

    def test_appending_tables_does_not_renumber_existing_paragraph_evidence(self):
        html = '<p>Before</p><table><tr><td>Data</td></tr></table><p>After</p>'
        events = self.parse(html)
        paragraphs = [event for event in events if event['type'] == 'record' and not event['values'].get('c3')]
        self.assertEqual([row['values']['c2'] for row in paragraphs], ['document', 'document', 'document'])
        self.assertEqual([row['values']['c1'] for row in paragraphs], ['Before', 'Data', 'After'])
        self.assertEqual([row['index'] for row in paragraphs], [1, 2, 3])
