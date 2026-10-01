"""Bounded original/OOXML/HTML/geometry preflight for the frozen Goal100 inputs.

No recursive discovery, provider access, binary DOC conversion or data publication.
"""
import argparse
import hashlib
import json
import math
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from decimal import Decimal
from html.parser import HTMLParser
from pathlib import Path
from zipfile import ZipFile

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
MAX_BYTES = 8 * 1024 * 1024


def bounded(path):
    if path.stat().st_size > MAX_BYTES:
        raise ValueError('SIZE_LIMIT')
    return path.read_bytes()


def file_receipt(root, path, role='original', expected=None):
    path = Path(path)
    raw = bounded(path)
    digest = hashlib.sha256(raw).hexdigest()
    if expected and digest != expected:
        raise ValueError('HASH_MISMATCH:' + str(path))
    return {'role': role, 'path': str(path.relative_to(root)), 'sha256': digest,
            'expectedSha256': expected or digest, 'matches': True, 'bytes': len(raw)}


def paragraph_text(paragraph):
    return ''.join((node.text or '') if node.tag == W + 't' else '\t' if node.tag == W + 'tab'
                   else '\n' if node.tag in (W + 'br', W + 'cr') else '' for node in paragraph.iter())


def read_ooxml(path):
    with ZipFile(path) as archive:
        info = archive.getinfo('word/document.xml')
        if info.file_size > MAX_BYTES:
            raise ValueError('SIZE_LIMIT')
        raw = archive.read(info)
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('XML_DECLARATION_FORBIDDEN')
    document = ET.fromstring(raw)
    output = []
    for number, table in enumerate(document.iter(W + 'tbl'), 1):
        if number > 128 or any(child is not table for child in table.iter(W + 'tbl')):
            raise ValueError('NESTED_TABLE_UNRESOLVED')
        for index, row in enumerate(table.findall(W + 'tr'), 1):
            before = row.find(W + 'trPr/' + W + 'gridBefore')
            column = 1 + (int(before.get(W + 'val')) if before is not None else 0)
            cells = []
            for cell in row.findall(W + 'tc'):
                if any(child.tag not in (W + 'tcPr', W + 'p') for child in cell):
                    raise ValueError('CELL_STRUCTURE_UNRESOLVED')
                span_node = cell.find(W + 'tcPr/' + W + 'gridSpan')
                span = int(span_node.get(W + 'val')) if span_node is not None else 1
                merge_node = cell.find(W + 'tcPr/' + W + 'vMerge')
                merge = merge_node.get(W + 'val', 'continue') if merge_node is not None else None
                if cell.find(W + 'tcPr/' + W + 'hMerge') is not None or not 1 <= span <= 256 or merge not in (None, 'restart', 'continue'):
                    raise ValueError('MERGE_STRUCTURE_UNRESOLVED')
                text = '\n'.join(paragraph_text(p) for p in cell.findall(W + 'p'))
                cells.append({'column': column, 'columnSpan': span, 'verticalMerge': merge, 'text': text})
                column += span
            output.append({'kind': 'word_table_row', 'sourcePart': 'word/document.xml', 'tableIndex': number, 'rowIndex': index, 'cells': cells})
    if sum(len(row['cells']) for row in output) > 20000:
        raise ValueError('CELL_LIMIT')
    date_context = [{'text': paragraph_text(p), 'location': f'word/document.xml#paragraph:{index}'}
                    for index, p in enumerate(document.iter(W + 'p'), 1)
                    if re.search(r'20\d{2}年\s*\d{1,2}月', paragraph_text(p))]
    return output, date_context


class ContentParagraphs(HTMLParser):
    def __init__(self, class_name):
        super().__init__(convert_charrefs=True)
        self.class_name = class_name
        self.stack = []
        self.active_depth = None
        self.capture = None
        self.blocks = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if self.active_depth is None and self.class_name in attributes.get('class', '').split():
            self.active_depth = len(self.stack) + 1
        if self.active_depth is not None and tag == 'p':
            self.capture = []
        if tag == 'br' and self.capture is not None:
            self.capture.append('\n')
        if tag not in ('br', 'img', 'meta', 'link', 'hr', 'input', 'source', 'wbr', 'area', 'base', 'embed', 'param'):
            self.stack.append(tag)

    def handle_data(self, data):
        if self.capture is not None:
            self.capture.append(data)

    def handle_endtag(self, tag):
        if tag == 'p' and self.capture is not None:
            value = ''.join(self.capture).strip()
            if value:
                self.blocks.append({'locator': f'html:class:{self.class_name}/p:{len(self.blocks) + 1}', 'text': value})
            self.capture = None
        if tag in self.stack:
            index = len(self.stack) - 1 - self.stack[::-1].index(tag)
            self.stack = self.stack[:index]
        if self.active_depth is not None and len(self.stack) < self.active_depth:
            self.active_depth = None


def paragraph_blocks(html, class_name):
    parser = ContentParagraphs(class_name)
    parser.feed(html)
    return parser.blocks


def rings_from_ways(members):
    chains = []
    for member in members:
        if member['type'] != 'way' or member['role'] not in ('outer', 'inner'):
            continue
        if member['role'] == 'inner':
            raise ValueError('INNER_REQUIRES_CONTAINMENT')
        coords = [[p['lon'], p['lat']] for p in member['geometry']]
        if len(coords) < 2 or any(not math.isfinite(x) or not math.isfinite(y) or not -180 <= x <= 180 or not -90 <= y <= 90 for x, y in coords):
            raise ValueError('INVALID_COORDINATES')
        chains.append(coords)
    rings = []
    while chains:
        ring = chains.pop(0)
        while ring[-1] != ring[0]:
            choices = [(i, chain) for i, chain in enumerate(chains) if chain[0] == ring[-1] or chain[-1] == ring[-1]]
            if len(choices) != 1:
                raise ValueError('OPEN_OR_AMBIGUOUS_BOUNDARY')
            index, chain = choices[0]
            chains.pop(index)
            if chain[-1] == ring[-1]:
                chain = list(reversed(chain))
            ring.extend(chain[1:])
        signed = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:]))
        if len(ring) < 4 or signed == 0:
            raise ValueError('DEGENERATE_RING')
        rings.append(list(reversed(ring)) if signed < 0 else ring)
    if len(rings) != 1:
        raise ValueError('MULTIPLE_OUTER_UNRESOLVED')
    return rings


def simple_ring(ring):
    """Exact segment tests at OSM's retained decimal precision; no geometry mutation."""
    points = []
    for point in ring:
        scaled = [Decimal(str(value)) * 10 ** 7 for value in point]
        if any(value != value.to_integral_value() for value in scaled):
            raise ValueError('OSM_PRECISION_UNEXPECTED')
        points.append(tuple(int(value) for value in scaled))
    if len(points) < 4 or points[0] != points[-1]:
        return False
    if len(set(points[:-1])) != len(points) - 1:
        return False
    segments = [(min(a[0], b[0]), max(a[0], b[0]), min(a[1], b[1]), max(a[1], b[1]), index, a, b)
                for index, (a, b) in enumerate(zip(points, points[1:]))]
    def orient(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    def opposite_or_zero(a, b):
        return a == 0 or b == 0 or (a < 0) != (b < 0)
    active = []
    for current in sorted(segments):
        xmin, _, ymin, ymax, index, a, b = current
        active = [segment for segment in active if segment[1] >= xmin]
        for other in active:
            if abs(other[4] - index) == 1 or {other[4], index} == {0, len(segments) - 1}:
                continue
            if other[3] < ymin or other[2] > ymax:
                continue
            c, d = other[5], other[6]
            if opposite_or_zero(orient(a, b, c), orient(a, b, d)) and opposite_or_zero(orient(c, d, a), orient(c, d, b)):
                return False
        active.append(current)
    return True


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def main(root):
    output = root / 'outputs/2026-10-02-goal100/b'
    manifest = json.loads((root / 'outputs/2026-09-21-goal85/monthly/manifest.json').read_text())
    ledger_path = output / 'original-ledger.json'
    ledger = json.loads(ledger_path.read_text())
    inputs, audit = [], []
    for source in manifest['sources']:
        original = file_receipt(root, root / source['originalPath'], expected=source['originalSha256'])
        converted = file_receipt(root, root / source['convertedPath'], 'format-copy', source['convertedSha256'])
        old_path = root / f"outputs/2026-09-21-goal85/monthly/{source['sourceMonth']}-input.json"
        file_receipt(root, old_path, 'derived-input', source['inputSha256'])
        old = json.loads(old_path.read_text())
        rows, dates = read_ooxml(root / source['convertedPath'])
        if rows != old['tables'] or dates != old['dateContext']:
            raise ValueError('FULL_STRUCTURE_OR_VALUE_MISMATCH:' + source['sourceId'])
        inputs.append({**old, 'tables': rows, 'dateContext': dates})
        audit.append({'sourceId': source['sourceId'], 'original': original, 'formatCopy': converted,
                      'physicalRows': len(rows), 'physicalCells': sum(len(row['cells']) for row in rows),
                      'fullStructureMatches': True, 'fullValuesMatch': True, 'dateContextMatches': True,
                      'boundary': 'Pinned existing DOCX conversion fully re-read; original binary DOC hash verified, conversion not repeated.'})
    write_json(output / 'prepared-monthly-inputs.json', inputs)
    write_json(output / 'monthly-full-audit.json', audit)
    receipts = json.loads((output / 'acquisition-receipts.json').read_text())
    new_entries = []
    reports = []
    for identity, class_name in [('tianjin-2025-release', 'TRS_UEDITOR'), ('hebei-2024-bulletin-lf', 'articleCon')]:
        acquired = next(receipt for receipt in receipts if receipt['id'] == identity and receipt['state'] == 'obtained')
        path = root / acquired['path']
        receipt = file_receipt(root, path, expected=acquired['sha256'])
        blocks = paragraph_blocks(bounded(path).decode('utf-8'), class_name)
        if not blocks:
            raise ValueError('ARTICLE_CONTENT_MISSING:' + identity)
        reports.append({'sourceId': identity, 'original': receipt, 'url': acquired['url'], 'blocks': blocks})
        new_entries.append({'id': identity, 'workId': identity, 'versionId': receipt['sha256'], 'newOriginal': True, 'attemptCount': 1, 'state': 'hash-and-content-verified', 'retainedAfterFailure': True, 'files': [receipt]})
    policy_path = root / 'local-data/2026-09-12-overnight/sources/bth-haihe-2023/original.html'
    policy_receipt = file_receipt(root, policy_path, expected='2efb7a54c0741a78ed48acb9acda0b957817267379310a3c9a1bd7f86ad98386')
    policy_readable = root / 'local-data/2026-09-12-overnight/sources/bth-haihe-2023/readable.md'
    policy_text = policy_readable.read_text()
    class Flat(HTMLParser):
        def __init__(self):
            super().__init__(); self.text = []
        def handle_data(self, value):
            self.text.append(value)
    flat = Flat(); flat.feed(bounded(policy_path).decode('utf-8'))
    plain = re.sub(r'\s+', '', ''.join(flat.text))
    policy_blocks = []
    for number in (10, 12, 13, 29):
        text = re.search(rf'\[paragraph:{number}\]\n(.*?)(?=\n\[paragraph:|\Z)', policy_text, re.S).group(1).strip()
        if re.sub(r'\s+', '', text) not in plain:
            raise ValueError('POLICY_EXCERPT_MISMATCH')
        policy_blocks.append({'locator': f'fixed-readable:paragraph:{number}', 'text': text})
    reports.append({'sourceId': 'bth-haihe-2023', 'original': policy_receipt, 'url': 'https://www.mee.gov.cn/zcwj/zcjd/202306/t20230605_1032610.shtml', 'blocks': policy_blocks})
    new_entries.append({'id': 'bth-haihe-2023', 'workId': 'bth-haihe-2023', 'versionId': policy_receipt['sha256'], 'newOriginal': False, 'attemptCount': 1, 'state': 'hash-and-excerpt-verified', 'retainedAfterFailure': True, 'files': [policy_receipt, file_receipt(root, policy_readable, 'derived-readable')]})
    write_json(output / 'prepared-report-paragraphs.json', reports)
    old_folder = root / 'local-data/2026-09-20-spatial-anchors'
    old_geo = json.loads((old_folder / 'spatial-reference.geojson').read_text())
    geometries = []
    areas_expected = {2988895: '大兴区', 2988896: '房山区', 2988946: '丰台区', 5505985: '石景山区'}
    for identity, filename, expected_hash in [('osm-admin-reference-20260919', 'osm-areas-original.json', '2d867a13d284c0423c252020362d9abc46e765a786e3b54a6a53c526bf2fa592'), ('osm-river-reference-20260919', 'osm-original.json', '8c482bae58f4ef8192a4b9a4b6ebc9fdf6af5d937bde8d2b205ce880728673d1')]:
        receipt = file_receipt(root, old_folder / filename, expected=expected_hash)
        data = json.loads((old_folder / filename).read_text())
        if 'admin' in identity:
            for element in data['elements']:
                if element['type'] != 'relation' or areas_expected.get(element['id']) != element['tags']['name'] or element['tags'].get('boundary') != 'administrative':
                    raise ValueError('REFERENCE_IDENTITY_MISMATCH')
                geometry = {'type': 'Polygon', 'coordinates': rings_from_ways(element['members'])}
                old = next(feature for feature in old_geo['features'] if feature['id'] == f"osm-relation-{element['id']}")
                if old['geometry'] != geometry:
                    raise ValueError('REFERENCE_GEOMETRY_MISMATCH')
                geometries.append({**old, 'sourceId': identity, 'versionId': receipt['sha256'], 'nativeCrs': 'EPSG:4326'})
        else:
            ways = [element for element in data['elements'] if element['type'] == 'way']
            if len(ways) != 15 or not all(element['tags'].get('name') == '永定河' and element['tags'].get('waterway') == 'river' for element in ways):
                raise ValueError('REFERENCE_RIVER_IDENTITY_MISMATCH')
            old = next(feature for feature in old_geo['features'] if feature['id'] == 'osm-yongding-selected-route')
            geometry = {'type': 'MultiLineString', 'coordinates': [[[point['lon'], point['lat']] for point in way['geometry']] for way in ways]}
            if old['geometry'] != geometry:
                raise ValueError('REFERENCE_GEOMETRY_MISMATCH')
            geometries.append({**old, 'sourceId': identity, 'versionId': receipt['sha256'], 'nativeCrs': 'EPSG:4326'})
        new_entries.append({'id': identity, 'workId': 'openstreetmap', 'versionId': receipt['sha256'], 'newOriginal': False, 'attemptCount': 1, 'state': 'hash-identity-and-geometry-verified', 'retainedAfterFailure': True, 'files': [receipt]})
    acquired = next(receipt for receipt in receipts if receipt['id'] == 'osm-two-areas' and receipt['state'] == 'obtained')
    receipt = file_receipt(root, root / acquired['path'], expected=acquired['sha256'])
    data = json.loads((root / acquired['path']).read_text())
    expected = {2988899: '密云区', 2988902: '通州区'}
    if len(data['elements']) != 2:
        raise ValueError('REFERENCE_SCOPE_MISMATCH')
    for element in data['elements']:
        if element['type'] != 'relation' or expected.get(element['id']) != element['tags']['name'] or element['tags'].get('boundary') != 'administrative' or element['tags'].get('admin_level') != '6' or element['tags'].get('type') != 'boundary':
            raise ValueError('REFERENCE_IDENTITY_MISMATCH')
        geometries.append({'type': 'Feature', 'id': f"osm-relation-{element['id']}", 'sourceId': 'osm-two-areas', 'versionId': receipt['sha256'], 'nativeCrs': 'EPSG:4326', 'properties': {
            'name': element['tags']['name'], 'osm_id': str(element['id']), 'osm_version': element['version'],
            'geometry_date': data['osm3s']['timestamp_osm_base'], 'source_url': f"https://www.openstreetmap.org/relation/{element['id']}",
            'source_attribution': '© OpenStreetMap contributors · ODbL 1.0', 'license_url': 'https://www.openstreetmap.org/copyright',
            'limitation': '行政区参考范围；不是法定界线、精确河段、采样范围或2023年边界。'},
            'geometry': {'type': 'Polygon', 'coordinates': rings_from_ways(element['members'])}})
    new_entries.append({'id': 'osm-two-areas', 'workId': 'openstreetmap', 'versionId': receipt['sha256'], 'newOriginal': True, 'attemptCount': 1, 'state': 'hash-identity-and-geometry-verified', 'retainedAfterFailure': True, 'files': [receipt], 'query': acquired['query'], 'retrievedAt': acquired['retrievedAt']})
    write_json(output / 'prepared-reference-geometries.json', geometries)
    geometry_audit = []
    for feature in geometries:
        geometry = feature['geometry']
        is_polygon = geometry['type'] == 'Polygon'
        rings_simple = all(simple_ring(ring) for ring in geometry['coordinates']) if is_polygon else None
        if is_polygon and not rings_simple:
            raise ValueError('POLYGON_SELF_INTERSECTION:' + feature['id'])
        geometry_audit.append({'id': feature['id'], 'sourceId': feature['sourceId'], 'sourceVersionId': feature['versionId'],
                               'type': geometry['type'], 'vertices': sum(len(line) for line in geometry['coordinates']),
                               'polygonRingsSimple': rings_simple, 'originalCoordinatesRetained': True,
                               'crs': 'EPSG:4326', 'axisOrder': 'longitude,latitude',
                               'role': 'reference', 'professionalReview': 'pending', 'controlPointVerified': False,
                               'scale': 'Native OSM coordinates; no accuracy, map scale or historic boundary equivalence asserted.'})
    write_json(output / 'reference-geometry-audit.json', {'conversion': 'Equal endpoint stitching and ring orientation only; no simplification, smoothing, snapping or centroids.',
               'crsBasis': 'OpenStreetMap WGS 84 decimal longitude/latitude coordinates, retained in GeoJSON longitude/latitude order.',
               'coordinateDocumentation': 'https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL',
               'datumDocumentation': 'https://wiki.openstreetmap.org/wiki/GIS_FAQ',
               'license': 'ODbL 1.0', 'attribution': '© OpenStreetMap contributors',
               'licenseUrl': 'https://www.openstreetmap.org/copyright', 'features': geometry_audit})
    keys = {(entry['id'], entry['versionId']) for entry in ledger['entries']}
    ledger['entries'].extend(entry for entry in new_entries if (entry['id'], entry['versionId']) not in keys)
    failure_keys = {(item['id'], item['retrievedAt']) for item in ledger['publicRetrievalFailures']}
    ledger['publicRetrievalFailures'].extend(item for item in receipts if item['state'] != 'obtained' and (item['id'], item['retrievedAt']) not in failure_keys)
    attempts = sum(entry['attemptCount'] for entry in ledger['entries'])
    new_count = sum(entry['newOriginal'] for entry in ledger['entries'])
    if attempts > ledger['limits']['attemptedOriginalVersions'] or new_count > ledger['limits']['newOriginals']:
        raise ValueError('ORIGINAL_BUDGET_EXCEEDED')
    ledger['totals'] = {'attemptedOriginalVersions': attempts, 'newOriginals': new_count, 'publicRetrievalFailures': len(ledger['publicRetrievalFailures']), 'independentWorks': len({entry['workId'] for entry in ledger['entries']})}
    ledger['verifiedAt'] = datetime.now(timezone.utc).isoformat()
    write_json(ledger_path, ledger)
    print(json.dumps({'monthlySources': len(inputs), 'physicalCells': sum(item['physicalCells'] for item in audit), 'reportSources': len(reports), 'referenceGeometries': len(geometries), 'ledger': ledger['totals']}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-root', required=True, type=Path)
    main(parser.parse_args().data_root.resolve())
