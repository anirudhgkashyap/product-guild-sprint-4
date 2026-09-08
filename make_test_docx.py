"""
make_test_docx.py — builds a minimal .docx with real w:ins/w:del markup.

Why this exists: python-docx cannot create Track Changes (its API has
no concept of revisions), so there's no easy way to generate a test
file for the parser above without either (a) finding a real redlined
contract, or (b) hand-building the OOXML package. This script does (b),
by writing the three files a minimal .docx needs — document.xml,
[Content_Types].xml, and _rels/.rels — directly, then zipping them.

Run this once to get a fixture, then point the parser at it:
    python make_test_docx.py sample.docx
    python track_changes_parser.py sample.docx
"""

import sys
import zipfile

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

# Two paragraphs, each with one insertion and one deletion, from two
# different "authors" and dates — enough to exercise every branch of
# the parser (multiple paragraphs, multiple authors, both change types).
DOCUMENT_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t xml:space="preserve">The Vendor shall deliver the Services within </w:t></w:r>
      <w:del w:id="1" w:author="Jane Smith (Drafting)" w:date="2026-08-01T10:00:00Z">
        <w:r><w:delText xml:space="preserve">thirty (30)</w:delText></w:r>
      </w:del>
      <w:ins w:id="2" w:author="Jane Smith (Drafting)" w:date="2026-08-01T10:00:00Z">
        <w:r><w:t xml:space="preserve">forty-five (45)</w:t></w:r>
      </w:ins>
      <w:r><w:t xml:space="preserve"> days of the Effective Date.</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">Either party may terminate this Agreement </w:t></w:r>
      <w:ins w:id="3" w:author="Raj Patel (Counterparty)" w:date="2026-08-02T14:30:00Z">
        <w:r><w:t xml:space="preserve">for convenience with sixty (60) days written notice, or </w:t></w:r>
      </w:ins>
      <w:r><w:t xml:space="preserve">for cause upon material breach.</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">This is an unmodified paragraph with no tracked changes.</w:t></w:r>
    </w:p>
  </w:body>
</w:document>"""


def build(output_path: str) -> None:
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", DOCUMENT_XML)
    print(f"Test .docx with tracked changes written to: {output_path}")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "sample_tracked_changes.docx"
    build(out)
