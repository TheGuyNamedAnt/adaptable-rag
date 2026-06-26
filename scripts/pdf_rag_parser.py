#!/usr/bin/env python3
import base64
import json
import sys
import tempfile
from pathlib import Path
from typing import Any


def main() -> int:
    try:
        request = json.load(sys.stdin)
        result = parse_pdf(request)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ModuleNotFoundError as error:
        if error.name in {"pdfplumber", "pypdf"}:
            print(
                "PDF parser requires pdfplumber or pypdf. Set RAG_PDF_PYTHON to a Python "
                "environment that has one of those packages.",
                file=sys.stderr,
            )
            return 2
        raise
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


def parse_pdf(request: dict[str, Any]) -> dict[str, Any]:
    source_path, cleanup_dir = materialize_source(request)
    try:
        pages, warnings = extract_pages(source_path)
        body, regions = build_body_and_regions(pages)
        layout = {
            "parserId": "pdf-rag-parser",
            "strategy": "text_layer",
            "pages": [
                {
                    "pageNumber": page["pageNumber"],
                    "width": max(1, page["width"]),
                    "height": max(1, page["height"]),
                    "unit": "point",
                }
                for page in pages
            ]
            or [{"pageNumber": 1, "width": 1, "height": 1, "unit": "point"}],
            "regions": regions
            or [
                {
                    "id": "empty_pdf_text_layer",
                    "kind": "paragraph",
                    "pageNumber": 1,
                    "text": body,
                    "characterStart": 0,
                    "characterEnd": len(body),
                }
            ],
            "tables": [],
            "visualAssets": [],
            "metadata": {
                "sourceId": str(request.get("sourceId") or ""),
                "normalizer": "pdf-rag-parser",
                "pageCount": len(pages),
            },
        }
        if not body.strip():
            warnings.append(
                {
                    "code": "pdf_text_layer_empty",
                    "message": "No selectable PDF text was extracted; OCR may be required.",
                }
            )
        return {
            "body": body,
            "layout": layout,
            "metadata": {"engine": "pdf_text", "pageCount": len(pages)},
            "warnings": warnings,
        }
    finally:
        if cleanup_dir is not None:
            cleanup_dir.cleanup()


def materialize_source(request: dict[str, Any]) -> tuple[Path, tempfile.TemporaryDirectory[str] | None]:
    path = request.get("path")
    if isinstance(path, str) and path and Path(path).exists():
        return Path(path), None

    origin_uri = request.get("originUri")
    if isinstance(origin_uri, str) and origin_uri.startswith("file://"):
        file_path = Path(origin_uri.removeprefix("file://"))
        if file_path.exists():
            return file_path, None

    cleanup_dir = tempfile.TemporaryDirectory(prefix="pdf-rag-")
    temp_dir = Path(cleanup_dir.name)
    bytes_base64 = request.get("bytesBase64")
    if isinstance(bytes_base64, str) and bytes_base64:
        source_path = temp_dir / "source.pdf"
        source_path.write_bytes(base64.b64decode(bytes_base64))
        return source_path, cleanup_dir

    raise ValueError("PDF parser requires path, file:// originUri, or bytesBase64.")


def extract_pages(source_path: Path) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    try:
        pages = extract_pages_with_pdfplumber(source_path)
        return pages, []
    except ModuleNotFoundError:
        return extract_pages_with_pypdf(source_path), [
            {
                "code": "pdfplumber_missing",
                "message": "pdfplumber is unavailable; used pypdf text extraction fallback.",
            }
        ]
    except Exception as error:
        try:
            return extract_pages_with_pypdf(source_path), [
                {
                    "code": "pdfplumber_failed",
                    "message": f"pdfplumber failed; used pypdf fallback: {error}",
                }
            ]
        except ModuleNotFoundError:
            raise error


def extract_pages_with_pdfplumber(source_path: Path) -> list[dict[str, Any]]:
    import pdfplumber

    pages = []
    with pdfplumber.open(str(source_path)) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            text = page.extract_text(layout=True) or page.extract_text() or ""
            pages.append(
                {
                    "pageNumber": index,
                    "width": float(page.width or 1),
                    "height": float(page.height or 1),
                    "text": text.strip("\n"),
                }
            )
    return pages


def extract_pages_with_pypdf(source_path: Path) -> list[dict[str, Any]]:
    from pypdf import PdfReader

    reader = PdfReader(str(source_path))
    pages = []
    for index, page in enumerate(reader.pages, start=1):
        box = page.mediabox
        width = float(box.width or 1)
        height = float(box.height or 1)
        pages.append(
            {
                "pageNumber": index,
                "width": width,
                "height": height,
                "text": (page.extract_text() or "").strip("\n"),
            }
        )
    return pages


def build_body_and_regions(pages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    body_parts: list[str] = []
    regions: list[dict[str, Any]] = []
    offset = 0
    region_index = 1

    for page in pages:
        if body_parts:
            offset += 2
        page_text = str(page.get("text") or "")
        page_start = offset
        body_parts.append(page_text)
        for line_start, line_end, line_text in non_empty_lines(page_text):
            regions.append(
                {
                    "id": f"page_{page['pageNumber']}_region_{region_index}",
                    "kind": region_kind(line_text),
                    "pageNumber": int(page["pageNumber"]),
                    "text": line_text,
                    "characterStart": page_start + line_start,
                    "characterEnd": page_start + line_end,
                }
            )
            region_index += 1
        offset += len(page_text)

    return "\n\n".join(body_parts), regions


def non_empty_lines(text: str) -> list[tuple[int, int, str]]:
    lines = []
    line_start = 0
    for raw_line in text.splitlines(keepends=True):
        line_without_break = raw_line.rstrip("\r\n")
        left_trimmed = line_without_break.lstrip()
        right_trimmed = left_trimmed.rstrip()
        if right_trimmed:
            start = line_start + (len(line_without_break) - len(left_trimmed))
            end = start + len(right_trimmed)
            lines.append((start, end, right_trimmed))
        line_start += len(raw_line)
    return lines


def region_kind(text: str) -> str:
    if "|" in text and text.count("|") >= 2:
        return "table"
    if len(text) <= 120 and text.isupper():
        return "heading"
    return "paragraph"


if __name__ == "__main__":
    raise SystemExit(main())
