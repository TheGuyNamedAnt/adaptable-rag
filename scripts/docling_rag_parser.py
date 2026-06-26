#!/usr/bin/env python3
import base64
import hashlib
import json
import mimetypes
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any


def main() -> int:
    try:
        request = json.load(sys.stdin)
        result = parse_with_docling(request)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ModuleNotFoundError as error:
        if error.name == "docling":
            print(
                "Docling is not installed. Install locally with `python3 -m pip install docling` "
                "or set RAG_DOCLING_PYTHON to a Python environment that has docling.",
                file=sys.stderr,
            )
            return 2
        raise
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


def parse_with_docling(request: dict[str, Any]) -> dict[str, Any]:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter
    from docling.document_converter import PdfFormatOption

    source_path, cleanup_dir = materialize_source(request)
    try:
        pipeline_options = PdfPipelineOptions()
        pipeline_options.do_ocr = os.environ.get("RAG_DOCLING_OCR", "").lower() in {
            "1",
            "true",
            "yes",
        }
        pipeline_options.generate_page_images = os.environ.get(
            "RAG_DOCLING_PAGE_IMAGES", ""
        ).lower() in {"1", "true", "yes"}
        pipeline_options.generate_picture_images = os.environ.get(
            "RAG_DOCLING_PICTURE_IMAGES", ""
        ).lower() in {"1", "true", "yes"}
        converter = DocumentConverter(
            format_options={
                InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)
            }
        )
        conversion = converter.convert(str(source_path))
        document = conversion.document
        body = export_markdown(document).strip()
        if not body:
            body = str(request.get("text") or "").strip()
        doc_dict = export_dict(document)
        layout = normalize_layout(doc_dict, body, request)
        warnings = []
        if not layout["tables"] and "table" in body.lower():
            warnings.append(
                {
                    "code": "docling_table_structure_unmapped",
                    "message": "Docling output mentioned tables but no structured table cells were mapped.",
                }
            )
        return {
            "body": body,
            "layout": layout,
            "metadata": {
                "engine": "docling",
                "sourcePath": str(source_path),
                "doclingDictAvailable": bool(doc_dict),
            },
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

    cleanup_dir = tempfile.TemporaryDirectory(prefix="docling-rag-")
    temp_dir = Path(cleanup_dir.name)
    bytes_base64 = request.get("bytesBase64")
    if isinstance(bytes_base64, str) and bytes_base64:
        suffix = suffix_for_request(request)
        source_path = temp_dir / f"source{suffix}"
        source_path.write_bytes(base64.b64decode(bytes_base64))
        return source_path, cleanup_dir

    text = str(request.get("text") or "")
    source_path = temp_dir / "source.txt"
    source_path.write_text(text, encoding="utf-8")
    return source_path, cleanup_dir


def suffix_for_request(request: dict[str, Any]) -> str:
    content_type = request.get("contentType")
    if isinstance(content_type, str):
        guessed = mimetypes.guess_extension(content_type.split(";")[0].strip())
        if guessed:
            return guessed
    title = str(request.get("title") or "").lower()
    for suffix in [".pdf", ".png", ".jpg", ".jpeg", ".tiff", ".docx", ".pptx", ".xlsx"]:
        if title.endswith(suffix):
            return suffix
    return ".bin"


def export_markdown(document: Any) -> str:
    if hasattr(document, "export_to_markdown"):
        return str(document.export_to_markdown())
    if hasattr(document, "export_to_text"):
        return str(document.export_to_text())
    return str(document)


def export_dict(document: Any) -> dict[str, Any]:
    for method_name in ["export_to_dict", "model_dump", "dict"]:
        method = getattr(document, method_name, None)
        if callable(method):
            value = method()
            if isinstance(value, dict):
                return value
    return {}


def normalize_layout(
    doc_dict: dict[str, Any], body: str, request: dict[str, Any]
) -> dict[str, Any]:
    pages = normalize_pages(doc_dict)
    regions = text_regions(body)
    tables = normalize_tables(doc_dict)
    visual_assets = normalize_visual_assets(doc_dict, body)
    relations = caption_relations(regions)
    return {
        "parserId": "docling-rag-parser",
        "strategy": "hybrid",
        "pages": pages or [{"pageNumber": 1, "width": 1, "height": 1, "unit": "normalized"}],
        "regions": regions,
        "relations": relations,
        "tables": tables,
        "visualAssets": visual_assets,
        "metadata": {
            "sourceId": str(request.get("sourceId") or ""),
            "normalizer": "docling-rag-parser",
        },
    }


def normalize_pages(doc_dict: dict[str, Any]) -> list[dict[str, Any]]:
    pages_value = doc_dict.get("pages")
    if isinstance(pages_value, dict):
        pages_iterable = pages_value.values()
    elif isinstance(pages_value, list):
        pages_iterable = pages_value
    else:
        pages_iterable = []

    pages = []
    for index, page in enumerate(pages_iterable, start=1):
        if not isinstance(page, dict):
            continue
        size = page.get("size") if isinstance(page.get("size"), dict) else {}
        width = numeric(page.get("width")) or numeric(size.get("width")) or 1
        height = numeric(page.get("height")) or numeric(size.get("height")) or 1
        page_no = int(numeric(page.get("page_no")) or numeric(page.get("pageNumber")) or index)
        pages.append({"pageNumber": page_no, "width": width, "height": height, "unit": "point"})
    return pages


def text_regions(body: str) -> list[dict[str, Any]]:
    regions = []
    for index, match in enumerate(re.finditer(r"\S(?:.*\S)?", body), start=1):
        text = match.group(0)
        kind = "heading" if text.startswith("#") else "paragraph"
        if is_tableish(text):
            kind = "table"
        if is_figure_caption(text):
            kind = "figure_caption"
        regions.append(
            {
                "id": f"region_{index}",
                "kind": kind,
                "pageNumber": 1,
                "text": text,
                "characterStart": match.start(),
                "characterEnd": match.end(),
            }
        )
    return regions or [
        {
            "id": "region_1",
            "kind": "paragraph",
            "pageNumber": 1,
            "text": body,
            "characterStart": 0,
            "characterEnd": len(body),
        }
    ]


def normalize_tables(doc_dict: dict[str, Any]) -> list[dict[str, Any]]:
    tables = []
    for index, table in enumerate(find_labeled_items(doc_dict, {"table"}), start=1):
        text = item_text(table)
        if not text:
            continue
        table_id = f"table_{index}"
        region_id = f"table_region_{index}"
        rows = [row for row in text.splitlines() if row.strip()]
        cells = []
        for row_index, row in enumerate(rows):
            columns = [column.strip() for column in re.split(r"\s*\|\s*|\t", row) if column.strip()]
            for column_index, column in enumerate(columns or [row.strip()]):
                cells.append({"rowIndex": row_index, "columnIndex": column_index, "text": column})
        tables.append(
            {
                "id": table_id,
                "pageNumber": page_number(table),
                "regionId": region_id,
                "cells": cells,
                "summary": text[:500],
            }
        )
    return tables


def normalize_visual_assets(doc_dict: dict[str, Any], body: str) -> list[dict[str, Any]]:
    assets = []
    for index, item in enumerate(find_labeled_items(doc_dict, {"picture", "figure", "image"}), start=1):
        payload = json.dumps(item, sort_keys=True, default=str).encode("utf-8")
        assets.append(
            {
                "id": f"figure_{index}",
                "kind": "figure",
                "pageNumber": page_number(item),
                "mediaType": "image/png",
                "checksum": hashlib.sha256(payload).hexdigest(),
            }
        )
    if not assets and re.search(r"\b(fig\.?|figure|image|chart|diagram)\b", body, re.I):
        assets.append({"id": "figure_1", "kind": "figure", "pageNumber": 1, "mediaType": "image/png"})
    return assets


def caption_relations(regions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    relations = []
    figure_region_ids = [region["id"] for region in regions if region["kind"] == "figure"]
    for region in regions:
        if region["kind"] == "figure_caption" and figure_region_ids:
            relations.append(
                {
                    "id": f"{region['id']}_caption_for_{figure_region_ids[0]}",
                    "kind": "caption_for",
                    "fromRegionId": region["id"],
                    "toRegionId": figure_region_ids[0],
                    "confidence": 0.7,
                }
            )
    return relations


def find_labeled_items(value: Any, labels: set[str]) -> list[dict[str, Any]]:
    found = []
    if isinstance(value, dict):
        label = str(value.get("label") or value.get("type") or value.get("kind") or "").lower()
        if label in labels:
            found.append(value)
        for child in value.values():
            found.extend(find_labeled_items(child, labels))
    elif isinstance(value, list):
        for child in value:
            found.extend(find_labeled_items(child, labels))
    return found


def item_text(item: dict[str, Any]) -> str:
    for key in ["text", "content", "markdown", "caption"]:
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def page_number(item: dict[str, Any]) -> int:
    for key in ["page_no", "pageNumber", "page"]:
        value = numeric(item.get(key))
        if value is not None:
            return max(1, int(value))
    prov = item.get("prov")
    if isinstance(prov, list) and prov and isinstance(prov[0], dict):
        return page_number(prov[0])
    return 1


def numeric(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def is_tableish(text: str) -> bool:
    return "|" in text and text.count("|") >= 2


def is_figure_caption(text: str) -> bool:
    return bool(re.match(r"^\s*(fig\.?|figure|chart|diagram)\s+\d+", text, re.I))


if __name__ == "__main__":
    raise SystemExit(main())
