"""Inert XML source nodes with exact namespace, sibling position and lexical text."""
import xml.etree.ElementTree as ET
from defusedxml import ElementTree as SafeET
from defusedxml.common import DefusedXmlException
from parser import ParseError, MAX_TEXT, record, schema

def xml_content(path):
    try:
        tree=SafeET.parse(path,forbid_dtd=True,forbid_entities=True,forbid_external=True)
    except (DefusedXmlException,ET.ParseError) as error:
        raise ParseError('INVALID_CONTENT') from error
    yield schema(['Element name','Text','Attributes','Source element path','Tail text'])
    root=tree.getroot()
    stack=[(root,[{'name':root.tag,'index':1}])]
    while stack:
        element,location=stack.pop()
        if len(location)>64:raise ParseError('CAPACITY_LIMIT')
        if len(element.tag)>512 or any(len(k)>512 for k in element.attrib):
            raise ParseError('COLUMN_LIMIT')
        if sum(len(v) for v in [element.text or '',element.tail or '',*element.attrib.values()])>MAX_TEXT:
            raise ParseError('SIZE_LIMIT')
        yield record({'c1':element.tag,'c2':element.text,'c3':dict(element.attrib),'c4':location,'c5':element.tail})
        counters={};children=[]
        for child in element:
            counters[child.tag]=counters.get(child.tag,0)+1
            children.append((child,location+[{'name':child.tag,'index':counters[child.tag]}]))
        stack.extend(reversed(children))
