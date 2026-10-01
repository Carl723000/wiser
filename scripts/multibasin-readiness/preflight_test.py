import unittest
from preflight import paragraph_blocks, rings_from_ways, read_ooxml
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile


class PreflightTests(unittest.TestCase):
    def test_html_extracts_only_selected_content_with_stable_paragraphs(self):
        blocks = paragraph_blocks('<p>navigation</p><div class="articleCon"><p>白洋淀<b>Ⅲ类</b></p><p>2024年</p></div><p>footer</p>', 'articleCon')
        self.assertEqual([item['text'] for item in blocks], ['白洋淀Ⅲ类', '2024年'])
        self.assertEqual(blocks[0]['locator'], 'html:class:articleCon/p:1')

    def test_geometry_stitches_only_exact_endpoints_and_rejects_unknown_inner(self):
        def member(coords, role='outer'):
            return {'type': 'way', 'role': role, 'geometry': [{'lon': x, 'lat': y} for x, y in coords]}
        ring = rings_from_ways([member([[0, 0], [1, 0], [1, 1]]), member([[0, 0], [0, 1], [1, 1]])])
        self.assertEqual(ring[0][0], ring[0][-1])
        self.assertEqual(len(ring[0]), 5)
        with self.assertRaisesRegex(ValueError, 'INNER'):
            rings_from_ways([member([[0, 0], [1, 0]], 'inner')])
        with self.assertRaisesRegex(ValueError, 'OPEN_OR_AMBIGUOUS'):
            rings_from_ways([member([[0, 0], [1, 0]])])

    def test_ooxml_rejects_entity_content_instead_of_expanding_it(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'bad.docx'
            with ZipFile(path, 'w') as archive:
                archive.writestr('word/document.xml', '<!DOCTYPE x [<!ENTITY bomb "secret">]><x>&bomb;</x>')
            with self.assertRaisesRegex(ValueError, 'XML_DECLARATION_FORBIDDEN'):
                read_ooxml(path)


if __name__ == '__main__':
    unittest.main()
