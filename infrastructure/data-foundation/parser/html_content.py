"""Bounded HTML table cells with source coordinates; no inferred units or facts."""
from html.parser import HTMLParser


class HtmlTables(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        self.unresolved = False
        self.depth = 0
        self.hidden = []
        self.index = 0
        self.total_cells = 0
        self.total_text = 0
        self.table = None
        self.row = None
        self.cell = None
        self.section = 'unknown'
        self.caption = False
        self.occupied = {}
        self.column = 1
        self.invalid = False

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'template'):
            self.hidden.append(tag)
        if self.hidden:
            return
        if tag == 'table':
            self.depth += 1
            if self.depth > 1:
                self.invalid = True
                return
            self.index += 1
            self.invalid = self.index > 128
            table_id = dict(attrs).get('id')
            if table_id is not None and len(table_id) > 512:
                self.invalid = True
                table_id = None
            self.table = {'tableIndex': self.index, 'tableId': table_id, 'caption': '', 'rows': []}
            self.row = self.cell = None
            self.occupied = {}
            self.section = 'unknown'
            return
        if self.depth != 1 or self.invalid:
            return
        if tag == 'caption':
            self.caption = True
        elif tag in ('thead', 'tbody', 'tfoot'):
            self.section = tag
        elif tag == 'tr':
            if self.row is not None:
                self.invalid = True
                return
            number = len(self.table['rows']) + 1
            if number > 10000:
                self.invalid = True
                return
            self.row = {'rowIndex': number, 'section': self.section, 'cells': []}
            self.column = 1
        elif tag in ('td', 'th'):
            if self.row is None or self.cell is not None:
                self.invalid = True
                return
            values = dict(attrs)
            try:
                row_span = int(values.get('rowspan', '1'))
                col_span = int(values.get('colspan', '1'))
                if not 1 <= row_span <= 10000 or not 1 <= col_span <= 256:
                    raise ValueError()
            except (ValueError, TypeError):
                self.invalid = True
                return
            row = self.row['rowIndex']
            while self.occupied.get(self.column, 0) >= row:
                self.column += 1
            end = self.column + col_span
            if end > 257 or row + row_span > 10001 or any(self.occupied.get(c, 0) >= row for c in range(self.column, end)):
                self.invalid = True
                return
            self.total_cells += 1
            if self.total_cells > 20000:
                self.invalid = True
                return
            self.cell = {'column': self.column, 'rowSpan': row_span, 'columnSpan': col_span, 'header': tag == 'th', 'text': ''}
            for c in range(self.column, end):
                self.occupied[c] = row + row_span - 1
            self.column = end
        elif tag == 'br' and self.cell is not None:
            self.handle_data('\n')

    def handle_endtag(self, tag):
        if self.hidden:
            if tag == self.hidden[-1]:
                self.hidden.pop()
            return
        if tag == 'table' and self.depth:
            self.depth -= 1
            if self.depth == 0:
                if self.invalid or self.row is not None or self.cell is not None:
                    self.unresolved = True
                else:
                    self.table['caption'] = ' '.join(self.table['caption'].split())
                    self.tables.append(self.table)
                self.table = self.row = self.cell = None
                self.caption = False
            return
        if self.depth != 1 or self.invalid:
            return
        if tag in ('td', 'th') and self.cell is not None:
            self.cell['text'] = ' '.join(self.cell['text'].split())
            self.row['cells'].append(self.cell)
            self.cell = None
        elif tag == 'tr':
            if self.row is None or self.cell is not None:
                self.invalid = True
            else:
                self.table['rows'].append(self.row)
                self.row = None
        elif tag == 'caption':
            self.caption = False
        elif tag in ('thead', 'tbody', 'tfoot'):
            self.section = 'unknown'

    def handle_data(self, data):
        if self.depth != 1 or self.hidden or self.invalid:
            return
        if self.cell is not None or self.caption:
            self.total_text += len(data)
            if self.total_text > 1_000_000:
                self.invalid = True
                return
        if self.cell is not None:
            self.cell['text'] += data
            if len(self.cell['text']) > 16000:
                self.invalid = True
        elif self.caption:
            self.table['caption'] += data
            if len(self.table['caption']) > 4096:
                self.invalid = True

    def close(self):
        super().close()
        if self.depth:
            self.unresolved = True


def html_table_rows(text):
    parser = HtmlTables()
    parser.feed(text)
    parser.close()
    for table in parser.tables:
        for row in table['rows']:
            yield {'kind': 'html_table_row', 'tableIndex': table['tableIndex'],
                   'tableId': table['tableId'], 'caption': table['caption'], **row}
    if parser.unresolved:
        yield {'warning': 'HTML_TABLE_STRUCTURE_UNRESOLVED'}
