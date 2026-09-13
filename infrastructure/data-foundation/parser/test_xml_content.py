"""XML nodes are source evidence, not interpreted observations or fetched links."""
import tempfile
import unittest
from pathlib import Path
from parser import parse_asset, ParseError

class XmlContentTest(unittest.TestCase):
    def parse(self, value, maximum=2000000):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'source.xml'
            path.write_bytes(value.encode('utf-8') if isinstance(value,str) else value)
            return list(parse_asset(path,'xml',maximum))

    def test_preserves_namespaces_repeated_nodes_attributes_and_lexical_values(self):
        events=self.parse('<r xmlns="urn:scene"><offset band_id="0">-1000</offset><offset band_id="1">001</offset><empty/></r>')
        rows=[x['values'] for x in events if x['type']=='record']
        self.assertEqual([r['c1'] for r in rows],['{urn:scene}r','{urn:scene}offset','{urn:scene}offset','{urn:scene}empty'])
        self.assertEqual(rows[1]['c2'],'-1000');self.assertEqual(rows[2]['c2'],'001')
        self.assertEqual(rows[1]['c3'],{'band_id':'0'})
        self.assertEqual(rows[2]['c4'],[{'name':'{urn:scene}r','index':1},{'name':'{urn:scene}offset','index':2}])
        self.assertIsNone(rows[3]['c2']);self.assertEqual(events[-1]['featureCount'],0)

    def test_preserves_mixed_text_tail_and_declared_encoding(self):
        events=self.parse('<?xml version="1.0" encoding="UTF-16"?><r>前<a>内</a>后</r>'.encode('utf-16'))
        rows=[x['values'] for x in events if x['type']=='record']
        self.assertEqual(rows[0]['c2'],'前');self.assertEqual(rows[1]['c2'],'内');self.assertEqual(rows[1]['c5'],'后')

    def test_refuses_dtd_entity_external_resource_and_malformed_xml(self):
        for value in ['<!DOCTYPE r><r/>','<!DOCTYPE r [<!ENTITY e SYSTEM "file:///etc/passwd">]><r>&e;</r>',
                      '<!DOCTYPE r SYSTEM "http://127.0.0.1/secret"><r/>','<r><unclosed></r>']:
            with self.subTest(value=value),self.assertRaisesRegex(ParseError,'INVALID_CONTENT'):
                self.parse(value)

    def test_bounded_depth_records_and_text(self):
        for value,maximum,code in [('<x>'*65+'</x>'*65,1000,'CAPACITY_LIMIT'),('<r><a/><b/></r>',2,'RECORD_LIMIT'),('<r>'+('a'*1000001)+'</r>',1000,'SIZE_LIMIT')]:
            with self.subTest(code=code),self.assertRaisesRegex(ParseError,code):self.parse(value,maximum)

    def test_links_and_schema_locations_remain_inert_strings(self):
        rows=[x['values'] for x in self.parse('<r href="http://127.0.0.1/private"><link>file:///etc/passwd</link></r>') if x['type']=='record']
        self.assertEqual(rows[0]['c3']['href'],'http://127.0.0.1/private')
        self.assertEqual(rows[1]['c2'],'file:///etc/passwd')
