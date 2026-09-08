"""
Track Changes Parser — Structural Diff Extraction Spike
=========================================================

Goal: prove that we can reliably pull Word Track Changes (w:ins / w:del
elements) out of a real .docx file's raw XML.

This deliberately does NOT use python-docx's high-level Document API,
because that API does not expose revision markup at all — python-docx
gives you paragraphs and runs, but w:ins/w:del live in the underlying
XML tree, so we parse word/document.xml directly with ElementTree.

Scope note: this produces a STRUCTURAL diff (what text was inserted or
deleted, by whom, when, in which paragraph). It does NOT understand
clauses, sections, or legal meaning — semantic/clause-level diffing is
explicitly out of scope for the MVP and is the real post-MVP
differentiator.

Usage:
    python track_changes_parser.py path/to/document.docx
    python track_changes_parser.py path/to/document.docx --json out.json
"""

import argparse
import json
import sys
import zipfile
from dataclasses import dataclass, field, asdict
from typing import Optional
from xml.etree import ElementTree as ET


# Word's XML namespace for the wordprocessingml schema. This is the one
# namespace that matters for Track Changes tags.
NAMESPACES = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
}


def qn(tag: str) -> str:
    """Turn 'w:author' into ElementTree's Clark notation: {uri}author."""
    prefix, local = tag.split(":")
    return f"{{{NAMESPACES[prefix]}}}{local}"


@dataclass
class Revision:
    """One tracked-change event: a single insertion or deletion block."""
    change_type: str            # "insertion" | "deletion"
    author: Optional[str]
    date: Optional[str]
    paragraph_index: int
    text: str
    revision_id: Optional[str] = None


@dataclass
class ParseResult:
    filename: str
    paragraph_count: int = 0
    revisions: list = field(default_factory=list)
    authors: list = field(default_factory=list)
    has_tracked_changes: bool = False
    warnings: list = field(default_factory=list)


class TrackChangesParser:
    """
    Parses word/document.xml directly to pull out w:ins and w:del
    elements with their author/date metadata and the text they carry.
    """

    def __init__(self, docx_path: str):
        self.docx_path = docx_path

    def parse(self) -> ParseResult:
        result = ParseResult(filename=self.docx_path)

        try:
            with zipfile.ZipFile(self.docx_path) as z:
                if "word/document.xml" not in z.namelist():
                    result.warnings.append(
                        "word/document.xml not found — is this a valid .docx?"
                    )
                    return result
                xml_bytes = z.read("word/document.xml")
        except zipfile.BadZipFile:
            result.warnings.append("File is not a valid zip/.docx archive.")
            return result
        except FileNotFoundError:
            result.warnings.append(f"File not found: {self.docx_path}")
            return result

        root = ET.fromstring(xml_bytes)
        body = root.find("w:body", NAMESPACES)
        if body is None:
            result.warnings.append("No <w:body> found in document.xml")
            return result

        paragraphs = body.findall("w:p", NAMESPACES)
        result.paragraph_count = len(paragraphs)

        authors_seen = set()

        for p_idx, paragraph in enumerate(paragraphs):
            # w:ins / w:del are searched as descendants (.//), not direct
            # children, because Word can nest them inside w:hyperlink or
            # other wrapper elements depending on how the edit was made.
            for ins in paragraph.findall(".//w:ins", NAMESPACES):
                text = self._extract_text(ins)
                if not text.strip():
                    continue
                author = ins.get(qn("w:author"))
                result.revisions.append(
                    Revision(
                        change_type="insertion",
                        author=author,
                        date=ins.get(qn("w:date")),
                        paragraph_index=p_idx,
                        text=text,
                        revision_id=ins.get(qn("w:id")),
                    )
                )
                if author:
                    authors_seen.add(author)

            for delete in paragraph.findall(".//w:del", NAMESPACES):
                text = self._extract_deleted_text(delete)
                if not text.strip():
                    continue
                author = delete.get(qn("w:author"))
                result.revisions.append(
                    Revision(
                        change_type="deletion",
                        author=author,
                        date=delete.get(qn("w:date")),
                        paragraph_index=p_idx,
                        text=text,
                        revision_id=delete.get(qn("w:id")),
                    )
                )
                if author:
                    authors_seen.add(author)

        result.has_tracked_changes = len(result.revisions) > 0
        result.authors = sorted(authors_seen)
        return result

    @staticmethod
    def _extract_text(element) -> str:
        """Visible text inside an <w:ins> block lives in <w:t> runs."""
        return "".join(t.text or "" for t in element.findall(".//w:t", NAMESPACES))

    @staticmethod
    def _extract_deleted_text(element) -> str:
        """
        Deleted text lives in <w:delText>, not <w:t> — Word keeps the
        struck-through run in the XML rather than removing it outright,
        which is exactly what makes the deletion recoverable/auditable.
        """
        return "".join(
            t.text or "" for t in element.findall(".//w:delText", NAMESPACES)
        )


def summarize(result: ParseResult) -> str:
    lines = [
        f"File: {result.filename}",
        f"Paragraphs: {result.paragraph_count}",
        f"Has tracked changes: {result.has_tracked_changes}",
        f"Authors: {', '.join(result.authors) or '(none found)'}",
        f"Total revisions: {len(result.revisions)}",
    ]
    if result.warnings:
        lines.append("Warnings:")
        lines.extend(f"  - {w}" for w in result.warnings)
    lines.append("")
    for rev in result.revisions:
        marker = "+" if rev.change_type == "insertion" else "-"
        lines.append(
            f"[{marker}] para {rev.paragraph_index} | {rev.author or 'unknown'} "
            f"| {rev.date or 'no date'} | {rev.text[:80]!r}"
        )
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Extract Track Changes from a .docx")
    parser.add_argument("docx_path", help="Path to the .docx file")
    parser.add_argument("--json", help="Optional path to write JSON output", default=None)
    args = parser.parse_args()

    result = TrackChangesParser(args.docx_path).parse()
    print(summarize(result))

    if args.json:
        with open(args.json, "w") as f:
            json.dump(asdict(result), f, indent=2, default=str)
        print(f"\nJSON written to {args.json}")

    # Non-zero exit if parsing hit a hard failure (bad file, no body) —
    # useful if you ever wire this spike into a CI gate.
    if result.warnings and not result.has_tracked_changes:
        sys.exit(1)


if __name__ == "__main__":
    main()
