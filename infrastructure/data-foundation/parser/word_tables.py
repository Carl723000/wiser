"""Retain bounded physical OOXML table cells, without resolving business meaning."""
import zipfile
from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException
from parser import MAX_INPUT_BYTES, MAX_TEXT, ParseError, safe_archive

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def word_table_rows(path):
    # Binary DOC keeps the existing inert antiword text path; no guessed table grid.
    if not zipfile.is_zipfile(path):
        return
    with safe_archive(path) as archive:
        part = 'word/document.xml'
        if part not in archive.namelist():
            raise ParseError('INVALID_FORMAT')
        if archive.getinfo(part).file_size > MAX_INPUT_BYTES:
            raise ParseError('SIZE_LIMIT')
        try:
            with archive.open(part) as source:
                root = ElementTree.parse(source, forbid_dtd=True, forbid_entities=True, forbid_external=True).getroot()
        except (DefusedXmlException, ElementTree.ParseError) as error:
            raise ParseError('INVALID_CONTENT') from error
    tables = list(root.iter(W+'tbl'))
    nested = {id(child) for table in tables for child in table.iter(W+'tbl') if child is not table}
    total_cells = total_text = 0
    for number, table in enumerate(tables, 1):
        if number > 128:
            yield {'warning': 'TABLE_STRUCTURE_UNRESOLVED'}
            return
        if id(table) in nested:
            continue
        if any(child is not table for child in table.iter(W+'tbl')):
            yield {'warning': 'TABLE_STRUCTURE_UNRESOLVED'}
            continue
        rows = []
        try:
            if any(child.tag not in (W+'tblPr', W+'tblGrid', W+'tr', W+'bookmarkStart', W+'bookmarkEnd') for child in table):
                raise ValueError()
            for index, tr in enumerate(table.findall(W+'tr'), 1):
                if index > 10000:
                    raise ValueError()
                if any(child.tag not in (W+'trPr', W+'tblPrEx', W+'tc', W+'bookmarkStart', W+'bookmarkEnd') for child in tr):
                    raise ValueError()
                before = tr.find(W+'trPr/'+W+'gridBefore')
                column = 1 + (int(before.get(W+'val')) if before is not None else 0)
                if not 1 <= column <= 256:
                    raise ValueError()
                cells = []
                for tc in tr.findall(W+'tc'):
                    if any(child.tag not in (W+'tcPr', W+'p') for child in tc):
                        raise ValueError()
                    span_node = tc.find(W+'tcPr/'+W+'gridSpan')
                    span = int(span_node.get(W+'val')) if span_node is not None else 1
                    merge_node = tc.find(W+'tcPr/'+W+'vMerge')
                    merge = merge_node.get(W+'val', 'continue') if merge_node is not None else None
                    # Legacy horizontal merges need a separate adapter, not guessed columns.
                    if tc.find(W+'tcPr/'+W+'hMerge') is not None or not 1 <= span <= 256 or column+span > 257 or merge not in (None, 'restart', 'continue'):
                        raise ValueError()
                    text = '\n'.join(''.join((c.text or '') if c.tag == W+'t' else '\t' if c.tag == W+'tab' else '\n' if c.tag in (W+'br', W+'cr') else '' for c in p.iter()) for p in tc.findall(W+'p'))
                    total_cells += 1
                    total_text += len(text)
                    if total_cells > 20000 or total_text > MAX_TEXT:
                        raise ValueError()
                    cells.append({'column': column, 'columnSpan': span, 'verticalMerge': merge, 'text': text})
                    column += span
                rows.append({'kind': 'word_table_row', 'sourcePart': part, 'tableIndex': number, 'rowIndex': index, 'cells': cells})
        except (ValueError, TypeError):
            yield {'warning': 'TABLE_STRUCTURE_UNRESOLVED'}
            if total_cells > 20000 or total_text > MAX_TEXT:
                return
            continue
        yield from rows
