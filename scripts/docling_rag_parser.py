#!/usr/bin/env python3
import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
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
    from docling.document_converter import ImageFormatOption
    from docling.document_converter import PdfFormatOption

    source_path, cleanup_dir = materialize_source(request)
    try:
        content_type = str(request.get("contentType") or "")
        is_image_input = content_type.startswith("image/")
        pipeline_options = PdfPipelineOptions()
        pipeline_options.do_ocr = is_image_input or os.environ.get("RAG_DOCLING_OCR", "").lower() in {
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
                InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options),
                InputFormat.IMAGE: ImageFormatOption(pipeline_options=pipeline_options),
            }
        )
        try:
            conversion = converter.convert(str(source_path))
            document = conversion.document
            doc_dict = export_dict(document)
            body = restore_formula_placeholders(export_markdown(document).strip(), doc_dict)
            body = restore_omitted_context_items(body, doc_dict)
            body = move_leading_page_markers_to_end(body)
            body = remove_leading_running_header_page_number(body)
        except Exception:
            if not is_image_input:
                raise
            doc_dict = {}
            body = ""
        body = enrich_image_placeholder_text(body, request, source_path)
        body = append_pdf_text_table_block(body, doc_dict, request, source_path)
        body = append_image_ocr_table_block(body, request, source_path)
        if not body:
            body = str(request.get("text") or "").strip()
        layout = normalize_layout(doc_dict, body, request, source_path)
        warnings = []
        if not layout["tables"] and "table" in body.lower():
            warnings.append(
                {
                    "code": "docling_table_structure_unmapped",
                    "message": "Docling output mentioned tables but no structured table cells were mapped.",
                }
            )
        if not layout["visualAssets"] and has_visual_reference(body):
            warnings.append(
                {
                    "code": "docling_visual_assets_unmapped",
                    "message": "Docling output referenced figures or diagrams but no visual assets were mapped.",
                }
            )
        return {
            "body": body,
            "layout": layout,
            "metadata": {
                "engine": "docling",
                "doclingDictAvailable": bool(doc_dict),
            },
            "warnings": warnings,
        }
    finally:
        if cleanup_dir is not None:
            cleanup_dir.cleanup()


def materialize_source(request: dict[str, Any]) -> tuple[Path, tempfile.TemporaryDirectory[str] | None]:
    path = request.get("path")
    if isinstance(path, str) and path and local_path_allowed(Path(path)):
        return Path(path), None

    origin_uri = request.get("originUri")
    if isinstance(origin_uri, str) and origin_uri.startswith("file://"):
        file_path = Path(origin_uri.removeprefix("file://"))
        if local_path_allowed(file_path):
            return file_path, None

    cleanup_dir = tempfile.TemporaryDirectory(prefix="docling-rag-")
    temp_dir = Path(cleanup_dir.name)
    bytes_base64 = request.get("bytesBase64")
    if isinstance(bytes_base64, str) and bytes_base64:
        suffix = suffix_for_request(request)
        source_path = temp_dir / f"source{suffix}"
        source_path.write_bytes(base64.b64decode(bytes_base64))
        return source_path, cleanup_dir

    text = request.get("text")
    if isinstance(text, str):
        source_path = temp_dir / "source.txt"
        source_path.write_text(text, encoding="utf-8")
        return source_path, cleanup_dir

    raise ValueError("Docling parser requires an allowed path, allowed file:// originUri, bytesBase64, or text.")


def local_path_allowed(path: Path) -> bool:
    if not path.exists():
        return False
    if os.environ.get("RAG_PARSER_ALLOW_LOCAL_PATHS", "").lower() not in {"1", "true", "yes"}:
        return False
    roots = [entry for entry in os.environ.get("RAG_PARSER_ALLOWED_ROOTS", "").split(os.pathsep) if entry]
    if not roots:
        return True
    resolved = path.resolve()
    for root in roots:
        try:
            resolved.relative_to(Path(root).resolve())
            return True
        except ValueError:
            continue
    return False


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


def restore_formula_placeholders(body: str, doc_dict: dict[str, Any]) -> str:
    formulas = [
        item_text(item)
        for item in find_labeled_items(doc_dict, {"formula", "equation"})
        if item_text(item)
    ]
    if not formulas:
        return body

    formula_iter = iter(formulas)

    def replace_placeholder(_match: re.Match[str]) -> str:
        return next(formula_iter, _match.group(0))

    return re.sub(r"<!--\s*formula-not-decoded\s*-->", replace_placeholder, body)


def restore_omitted_context_items(body: str, doc_dict: dict[str, Any]) -> str:
    normalized_body = normalize_presence_text(body)
    missing_items = []
    for item in find_text_items(doc_dict):
        label = str(item.get("label") or item.get("type") or item.get("kind") or "").lower()
        if not should_restore_omitted_context_label(label):
            continue
        text = item_text(item)
        if not text or is_page_marker_text(text) or normalize_presence_text(text) in normalized_body:
            continue
        box = box_sort_key(item)
        missing_items.append((box, text))

    if not missing_items:
        return body
    restored_text = "\n\n".join(text for _sort_key, text in sorted(missing_items, key=lambda entry: entry[0]))
    return "\n\n".join(part for part in [restored_text, body] if part.strip())


def should_restore_omitted_context_label(label: str) -> bool:
    return "caption" in label or "page_header" in label or "page_footer" in label


def move_leading_page_markers_to_end(body: str) -> str:
    blocks = [block.strip() for block in re.split(r"\n\s*\n", body) if block.strip()]
    if len(blocks) < 2:
        return body
    leading_markers = []
    while blocks and is_page_marker_text(blocks[0]):
        leading_markers.append(blocks.pop(0))
    if not leading_markers:
        return body
    return "\n\n".join([*blocks, *leading_markers])


def remove_leading_running_header_page_number(body: str) -> str:
    return re.sub(
        r"^(\s*)\d{1,3}\s+((?:CHAP\.|CHAPTER\b|[A-Z][A-Z.-]*(?:\s+[A-Z][A-Z.-]*){2,}).*)",
        r"\1\2",
        body,
        count=1,
    )


def is_page_marker_text(text: str) -> bool:
    stripped = text.strip()
    return bool(re.fullmatch(r"-?\s*\d{1,4}\s*-?", stripped))


def normalize_presence_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def enrich_image_placeholder_text(body: str, request: dict[str, Any], source_path: Path) -> str:
    content_type = str(request.get("contentType") or "").split(";")[0].strip()
    if not content_type.startswith("image/"):
        return body

    additions = missing_ocr_lines(body, tesseract_sparse_text(source_path))
    if not additions:
        return body

    ocr_block = "\n\n".join(additions)
    if "<!-- image -->" not in body.lower():
        return "\n\n".join(part for part in [body.strip(), ocr_block] if part)
    replacement = f"<!-- image -->\n\n{ocr_block}"
    return re.sub(r"<!--\s*image\s*-->", lambda _match: replacement, body, count=1, flags=re.I)


def append_image_ocr_table_block(body: str, request: dict[str, Any], source_path: Path) -> str:
    content_type = str(request.get("contentType") or "").split(";")[0].strip()
    if not content_type.startswith("image/"):
        return body
    if "|" in body:
        return body

    rows = image_ocr_table_rows(body, source_path)
    if len(rows) < 2:
        return body

    table_text = "\n".join(" | ".join(row) for row in rows)
    return f"{body.rstrip()}\n\n## OCR Table\n\n{table_text}".strip()


def image_ocr_table_rows(body: str, source_path: Path) -> list[list[str]]:
    entries = tesseract_line_entries(source_path)
    lines = [entry["text"] for entry in entries] or [
        normalize_ocr_table_cell(line)
        for line in body.splitlines()
        if is_useful_ocr_line(line) and not line.strip().startswith("<!--")
    ]
    lines = [line for line in lines if line and line.lower() not in {"ocr table"}]
    if len(lines) < 4:
        return []

    paired_rows = paired_value_rows(lines)
    if len(paired_rows) >= 2:
        return paired_rows

    if len(lines) % 2 == 0:
        rows = [[lines[index], lines[index + 1]] for index in range(0, len(lines), 2)]
        if material_table_rows(rows):
            return rows

    return []


def paired_value_rows(lines: list[str]) -> list[list[str]]:
    rows: list[list[str]] = []
    used: set[int] = set()
    for index, line in enumerate(lines):
        if index in used:
            continue
        next_line = lines[index + 1] if index + 1 < len(lines) else ""
        previous_line = lines[index - 1] if index > 0 else ""
        if is_short_table_value(line) and next_line and not is_short_table_value(next_line):
            rows.append([next_line, line])
            used.update({index, index + 1})
        elif next_line and not is_short_table_value(line) and is_short_table_value(next_line):
            rows.append([line, next_line])
            used.update({index, index + 1})
        elif previous_line and index - 1 not in used and is_short_table_value(line):
            rows.append([previous_line, line])
            used.update({index - 1, index})
    return rows


def is_short_table_value(line: str) -> bool:
    text = line.strip()
    if len(text) > 12:
        return False
    return bool(re.search(r"\d", text))


def normalize_ocr_table_cell(line: str) -> str:
    text = re.sub(r"\s+", " ", line.strip())
    text = re.sub(r"^[\[\(\{<|]+", "", text)
    text = re.sub(r"[\]\)\}>|]+$", "", text)
    return text.strip()


def tesseract_line_entries(source_path: Path) -> list[dict[str, Any]]:
    if shutil.which("tesseract") is None:
        return []
    try:
        result = subprocess.run(
            ["tesseract", str(source_path), "stdout", "--psm", "12", "tsv"],
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except Exception:
        return []
    if result.returncode != 0:
        return []

    groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    for line in result.stdout.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) < 12 or parts[0] != "5":
            continue
        text = normalize_ocr_table_cell(parts[11])
        if not text:
            continue
        key = (parts[2], parts[3], parts[4])
        left = integer_from_text(parts[6])
        top = integer_from_text(parts[7])
        width = integer_from_text(parts[8])
        height = integer_from_text(parts[9])
        if left is None or top is None or width is None or height is None:
            continue
        group = groups.setdefault(key, {"words": [], "boxes": []})
        group["words"].append(text)
        group["boxes"].append(
            {
                "pageNumber": 1,
                "x": left,
                "y": top,
                "width": width,
                "height": height,
                "unit": "pixel",
            }
        )

    entries = []
    for group in groups.values():
        text = normalize_ocr_table_cell(" ".join(group["words"]))
        box = union_boxes(group["boxes"])
        if text and box is not None:
            entries.append({"text": text, "box": box})
    return sorted(entries, key=lambda entry: (entry["box"]["y"], entry["box"]["x"]))


def integer_from_text(value: str) -> int | None:
    try:
        return int(float(value))
    except ValueError:
        return None


def append_pdf_text_table_block(
    body: str, doc_dict: dict[str, Any], request: dict[str, Any], source_path: Path
) -> str:
    content_type = str(request.get("contentType") or "").split(";")[0].strip()
    if content_type != "application/pdf" or docling_has_table_items(doc_dict):
        return body

    pdf_tables = pdf_text_tables(source_path)
    if not pdf_tables:
        return body

    blocks = []
    for index, table in enumerate(pdf_tables, start=1):
        text = "\n".join(" | ".join(row) for row in table["rows"]).strip()
        if not text:
            continue
        blocks.append(f"### Extracted PDF table {index} (page {int(table['pageNumber'])})\n\n{text}")
    if not blocks:
        return body

    return f"{body.rstrip()}\n\n## Extracted PDF Tables\n\n" + "\n\n".join(blocks)


def docling_has_table_items(doc_dict: dict[str, Any]) -> bool:
    return any(item_text(item) for item in find_labeled_items(doc_dict, {"table"}))


def tesseract_sparse_text(source_path: Path) -> str:
    if shutil.which("tesseract") is None:
        return ""
    try:
        result = subprocess.run(
            ["tesseract", str(source_path), "stdout", "--psm", "12"],
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except Exception:
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout


def missing_ocr_lines(body: str, ocr_text: str) -> list[str]:
    existing_lines = normalized_existing_lines(body)
    additions: list[str] = []
    seen = set()
    for raw_line in ocr_text.splitlines():
        line = raw_line.strip()
        normalized = normalize_presence_text(line)
        if not is_useful_ocr_line(line) or normalized in seen or normalized in existing_lines:
            continue
        seen.add(normalized)
        additions.append(line)
    return additions


def normalized_existing_lines(text: str) -> set[str]:
    lines = set()
    for raw_line in text.splitlines():
        line = re.sub(r"^#+\s*", "", raw_line).strip()
        if not line or line.startswith("<!--"):
            continue
        normalized = normalize_presence_text(line)
        if normalized:
            lines.add(normalized)
    return lines


def is_useful_ocr_line(line: str) -> bool:
    text = line.strip()
    return len(text) >= 2 and bool(re.search(r"[A-Za-z0-9]", text))


def box_sort_key(item: dict[str, Any]) -> tuple[int, float, float]:
    page = page_number(item)
    prov = item.get("prov")
    bbox = None
    if isinstance(prov, list) and prov and isinstance(prov[0], dict):
        raw_bbox = prov[0].get("bbox")
        if isinstance(raw_bbox, dict):
            bbox = raw_bbox
    if bbox is None and isinstance(item.get("bbox"), dict):
        bbox = item["bbox"]
    left = numeric(bbox.get("l") if isinstance(bbox, dict) else None) or 0
    top = numeric(bbox.get("t") if isinstance(bbox, dict) else None) or 0
    return (page, -top, left)


def normalize_layout(
    doc_dict: dict[str, Any], body: str, request: dict[str, Any], source_path: Path
) -> dict[str, Any]:
    pages = normalize_pages(doc_dict)
    add_source_image_page(pages, request, source_path)
    pages_by_number = {int(page.get("pageNumber") or 1): page for page in pages}
    regions = text_regions(body, doc_dict, pages_by_number)
    tables = normalize_tables(doc_dict, regions, pages_by_number)
    apply_image_ocr_table_boxes(tables, regions, request, source_path, pages_by_number)
    replace_synthetic_tables_with_pdf_text_tables(tables, regions, request, source_path, body)
    visual_assets = normalize_visual_assets(doc_dict, regions, pages_by_number)
    add_source_image_visual_asset(visual_assets, request, pages_by_number)
    add_source_pdf_visual_assets(visual_assets, request, pages_by_number, regions, body)
    add_compound_equation_subregions(regions)
    add_split_header_subregions(regions)
    pages = ensure_pages_cover_layout_items(pages, regions, tables, visual_assets)
    link_page_visual_assets(pages, visual_assets)
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


def add_source_image_page(pages: list[dict[str, Any]], request: dict[str, Any], source_path: Path) -> None:
    content_type = str(request.get("contentType") or "").split(";")[0].strip()
    if not content_type.startswith("image/") or pages:
        return
    dimensions = source_image_dimensions(source_path)
    if dimensions is None:
        return
    width, height = dimensions
    pages.append({"pageNumber": 1, "width": width, "height": height, "unit": "pixel"})


def source_image_dimensions(source_path: Path) -> tuple[int, int] | None:
    try:
        from PIL import Image
    except ModuleNotFoundError:
        return None
    try:
        with Image.open(source_path) as image:
            return int(image.width), int(image.height)
    except Exception:
        return None


def text_regions(
    body: str, doc_dict: dict[str, Any], pages_by_number: dict[int, dict[str, Any]]
) -> list[dict[str, Any]]:
    page_hints = text_page_hints(doc_dict, body, pages_by_number)
    regions = []
    for index, match in enumerate(re.finditer(r"\S(?:.*\S)?", body), start=1):
        text = match.group(0)
        page_number = page_number_for_text_region(match.start(), match.end(), text, page_hints)
        box = box_for_text_region(match.start(), match.end(), page_number, page_hints)
        kind = region_kind_for_text_region(match.start(), match.end(), text, page_hints)
        region = {
            "id": f"region_{index}",
            "kind": kind,
            "pageNumber": page_number,
            "text": text,
            "characterStart": match.start(),
            "characterEnd": match.end(),
        }
        if box is not None:
            region["box"] = box
        regions.append(
            region
        )
    return regions


def text_page_hints(
    doc_dict: dict[str, Any], body: str, pages_by_number: dict[int, dict[str, Any]]
) -> list[dict[str, Any]]:
    hints: list[dict[str, Any]] = []
    seen = set()
    search_from = 0
    for item in find_text_items(doc_dict):
        text = item_text(item)
        if not text:
            continue
        if should_skip_text_hint(item, text):
            continue
        page = page_number(item)
        start = body.find(text, search_from)
        if start < 0:
            start = body.find(text)
        if start < 0:
            continue
        end = start + len(text)
        key = (start, end, page)
        if key in seen:
            search_from = end
            continue
        seen.add(key)
        hint = {
            "start": start,
            "end": end,
            "pageNumber": page,
            "kind": region_kind_for_docling_item(item, text),
        }
        box = box_from_item(item, pages_by_number)
        if box is not None:
            hint["box"] = box
        hints.append(hint)
        search_from = end
    return sorted(hints, key=lambda hint: (hint["start"], hint["end"]))


def should_skip_text_hint(item: dict[str, Any], text: str) -> bool:
    label = str(item.get("label") or item.get("type") or item.get("kind") or "").lower()
    if is_page_marker_text(text):
        return True
    if "caption" in label or "header" in label or "footer" in label or "formula" in label:
        return False
    stripped = text.strip()
    if len(stripped) <= 3:
        return True
    if re.fullmatch(r"[\d.\-+]+", stripped):
        return True
    return False


def page_number_for_text_region(
    start: int, end: int, text: str, page_hints: list[dict[str, Any]]
) -> int:
    overlapping = [
        hint
        for hint in page_hints
        if max(start, hint["start"]) < min(end, hint["end"])
    ]
    if overlapping:
        return max(overlapping, key=lambda hint: min(end, hint["end"]) - max(start, hint["start"]))[
            "pageNumber"
        ]

    for hint in page_hints:
        if hint["start"] <= start <= hint["end"]:
            return hint["pageNumber"]
    for hint in page_hints:
        if hint["start"] <= end and hint["end"] >= start:
            return hint["pageNumber"]
    return 1


def box_for_text_region(
    start: int, end: int, page_number: int, page_hints: list[dict[str, Any]]
) -> dict[str, Any] | None:
    boxes = [
        hint["box"]
        for hint in page_hints
        if hint.get("pageNumber") == page_number
        and isinstance(hint.get("box"), dict)
        and max(start, int(hint["start"])) < min(end, int(hint["end"]))
    ]
    return union_boxes(boxes)


def region_kind_for_text_region(
    start: int, end: int, text: str, page_hints: list[dict[str, Any]]
) -> str:
    overlapping = [
        hint
        for hint in page_hints
        if max(start, int(hint["start"])) < min(end, int(hint["end"]))
    ]
    if overlapping:
        return str(
            max(overlapping, key=lambda hint: min(end, int(hint["end"])) - max(start, int(hint["start"]))).get(
                "kind"
            )
            or "paragraph"
        )
    if text.startswith("#"):
        return "heading"
    if is_tableish(text):
        return "table"
    if is_figure_caption(text):
        return "figure_caption"
    return "paragraph"


def normalize_tables(
    doc_dict: dict[str, Any],
    regions: list[dict[str, Any]],
    pages_by_number: dict[int, dict[str, Any]],
) -> list[dict[str, Any]]:
    tables = []
    used_region_ids = set()
    for index, table in enumerate(find_labeled_items(doc_dict, {"table"}), start=1):
        text = item_text(table)
        if not text:
            continue
        table_id = f"table_{index}"
        region_id = f"table_region_{index}"
        table_box = box_from_item(table, pages_by_number)
        page = page_number(table)
        cells = table_cells(table, pages_by_number)
        if not cells:
            cells = cells_from_table_text(text)
        table_region = {
            "id": region_id,
            "kind": "table",
            "pageNumber": page,
            "text": text,
        }
        table_start = body_region_start(regions, text)
        if table_start is not None:
            table_region["characterStart"] = table_start
            table_region["characterEnd"] = table_start + len(text)
        if table_box is not None:
            table_region["box"] = table_box
        regions.append(table_region)
        used_region_ids.add(region_id)
        tables.append(
            {
                "id": table_id,
                "pageNumber": page,
                "regionId": region_id,
                **({"box": table_box} if table_box is not None else {}),
                "cells": cells,
                "summary": text[:500],
            }
        )
    for group in synthetic_table_region_groups(regions, used_region_ids):
        if not group:
            continue
        text = "\n".join(str(region.get("text") or "") for region in group if str(region.get("text") or "").strip())
        table_id = f"table_{len(tables) + 1}"
        page = int(group[0].get("pageNumber") or 1)
        group_box = union_boxes(
            [region["box"] for region in group if isinstance(region.get("box"), dict)]
        )
        if len(group) == 1:
            region_id = str(group[0]["id"])
        else:
            region_id = f"synthetic_table_region_{len(tables) + 1}"
            region_start = min(
                (int(region["characterStart"]) for region in group if isinstance(region.get("characterStart"), int)),
                default=None,
            )
            region_end = max(
                (int(region["characterEnd"]) for region in group if isinstance(region.get("characterEnd"), int)),
                default=None,
            )
            table_region = {
                "id": region_id,
                "kind": "table",
                "pageNumber": page,
                "text": text,
                "metadata": {"sourceRegionIds": ",".join(str(region.get("id") or "") for region in group)},
            }
            if region_start is not None:
                table_region["characterStart"] = region_start
            if region_end is not None:
                table_region["characterEnd"] = region_end
            if group_box is not None:
                table_region["box"] = group_box
            regions.append(table_region)
        used_region_ids.update(str(region.get("id") or "") for region in group)
        table = {
            "id": table_id,
            "pageNumber": page,
            "regionId": region_id,
            **({"box": group_box} if group_box is not None else {}),
            "cells": cells_from_table_text(text),
            "summary": text[:500],
            "metadata": {"synthetic": True},
        }
        tables.append(table)
    return tables


def apply_image_ocr_table_boxes(
    tables: list[dict[str, Any]],
    regions: list[dict[str, Any]],
    request: dict[str, Any],
    source_path: Path,
    pages_by_number: dict[int, dict[str, Any]],
) -> None:
    content_type = str(request.get("contentType") or "").split(";")[0].strip()
    if not content_type.startswith("image/") or not tables:
        return

    table_box = image_ocr_table_box(source_path, pages_by_number)
    if table_box is None:
        return

    for table in tables:
        if not is_synthetic_table(table):
            continue
        table["box"] = table_box
        region_id = str(table.get("regionId") or "")
        for region in regions:
            if str(region.get("id") or "") == region_id:
                region["box"] = table_box


def image_ocr_table_box(
    source_path: Path, pages_by_number: dict[int, dict[str, Any]]
) -> dict[str, Any] | None:
    entries = tesseract_line_entries(source_path)
    if not entries:
        return None

    table_entries = entries_for_ocr_table(entries)
    if len(table_entries) < 2:
        return None
    box = union_boxes([entry["box"] for entry in table_entries if isinstance(entry.get("box"), dict)])
    if box is None:
        return None
    table_box = padded_box(box, source_image_dimensions(source_path), padding=8)
    page = pages_by_number.get(int(table_box.get("pageNumber") or 1))
    page_unit = str(page.get("unit") or "") if isinstance(page, dict) else ""
    if page_unit in {"pixel", "point", "normalized"}:
        table_box["unit"] = page_unit
    return table_box


def entries_for_ocr_table(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if 4 <= len(entries) <= 12:
        return entries
    rows = paired_value_entry_rows(entries)
    if rows:
        return [entry for row in rows for entry in row]
    if len(entries) >= 4 and len(entries) % 2 == 0:
        return entries
    return []


def paired_value_entry_rows(entries: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    rows: list[list[dict[str, Any]]] = []
    used: set[int] = set()
    for index, entry in enumerate(entries):
        if index in used:
            continue
        text = str(entry.get("text") or "")
        next_entry = entries[index + 1] if index + 1 < len(entries) else None
        previous_entry = entries[index - 1] if index > 0 else None
        next_text = str(next_entry.get("text") or "") if next_entry else ""
        previous_text = str(previous_entry.get("text") or "") if previous_entry else ""
        if is_short_table_value(text) and next_entry and next_text and not is_short_table_value(next_text):
            rows.append([next_entry, entry])
            used.update({index, index + 1})
        elif next_entry and next_text and not is_short_table_value(text) and is_short_table_value(next_text):
            rows.append([entry, next_entry])
            used.update({index, index + 1})
        elif (
            previous_entry
            and index - 1 not in used
            and previous_text
            and is_short_table_value(text)
        ):
            rows.append([previous_entry, entry])
            used.update({index - 1, index})
    return rows


def padded_box(
    box: dict[str, Any], dimensions: tuple[int, int] | None, padding: int
) -> dict[str, Any]:
    x = max(0.0, float(box["x"]) - padding)
    y = max(0.0, float(box["y"]) - padding)
    right = float(box["x"]) + float(box["width"]) + padding
    bottom = float(box["y"]) + float(box["height"]) + padding
    if dimensions is not None:
        right = min(float(dimensions[0]), right)
        bottom = min(float(dimensions[1]), bottom)
    return {
        "pageNumber": int(box.get("pageNumber") or 1),
        "x": round_float(x),
        "y": round_float(y),
        "width": round_float(max(0.0, right - x)),
        "height": round_float(max(0.0, bottom - y)),
        "unit": str(box.get("unit") or "pixel"),
    }


def synthetic_table_region_groups(
    regions: list[dict[str, Any]], used_region_ids: set[str]
) -> list[list[dict[str, Any]]]:
    candidates = []
    for region in regions:
        region_id = str(region.get("id") or "")
        if region_id in used_region_ids:
            continue
        if region.get("kind") != "table":
            continue
        text = str(region.get("text") or "")
        if not is_tableish(text):
            continue
        start = region.get("characterStart")
        end = region.get("characterEnd")
        candidates.append(
            {
                "region": region,
                "page": int(region.get("pageNumber") or 1),
                "start": int(start) if isinstance(start, int) else None,
                "end": int(end) if isinstance(end, int) else None,
            }
        )
    candidates.sort(
        key=lambda candidate: (
            candidate["page"],
            candidate["start"] if candidate["start"] is not None else 10**12,
        )
    )

    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    current_page: int | None = None
    last_end: int | None = None
    for candidate in candidates:
        page = int(candidate["page"])
        start = candidate["start"]
        end = candidate["end"]
        contiguous = (
            current
            and current_page == page
            and start is not None
            and last_end is not None
            and start <= last_end + 2
        )
        if not contiguous:
            if current:
                groups.append(current)
            current = []
        current.append(candidate["region"])
        current_page = page
        if end is not None:
            last_end = end
    if current:
        groups.append(current)
    return groups


def body_region_start(regions: list[dict[str, Any]], text: str) -> int | None:
    for region in regions:
        if region.get("text") == text and isinstance(region.get("characterStart"), int):
            return int(region["characterStart"])
    return None


def replace_synthetic_tables_with_pdf_text_tables(
    tables: list[dict[str, Any]],
    regions: list[dict[str, Any]],
    request: dict[str, Any],
    source_path: Path,
    body: str,
) -> None:
    content_type = str(request.get("contentType") or "").split(";")[0].strip()
    if content_type != "application/pdf":
        return
    if any(not is_synthetic_table(table) for table in tables):
        return

    pdf_tables = pdf_text_tables(source_path)
    if not pdf_tables:
        return

    synthetic_region_ids = {
        str(table.get("regionId") or "") for table in tables if is_synthetic_table(table)
    }
    regions[:] = [
        region for region in regions if str(region.get("id") or "") not in synthetic_region_ids
    ]
    tables[:] = [table for table in tables if not is_synthetic_table(table)]
    for index, pdf_table in enumerate(pdf_tables, start=1):
        table_id = f"pdf_text_table_{index}"
        region_id = f"pdf_text_table_region_{index}"
        rows = pdf_table["rows"]
        text = "\n".join(" | ".join(row) for row in rows)
        page_number = int(pdf_table["pageNumber"])
        character_start = body.find(text)
        regions.append(
            {
                "id": region_id,
                "kind": "table",
                "pageNumber": page_number,
                "text": text,
                "metadata": {"source": pdf_table["source"]},
                **(
                    {
                        "characterStart": character_start,
                        "characterEnd": character_start + len(text),
                    }
                    if character_start >= 0
                    else {}
                ),
            }
        )
        tables.append(
            {
                "id": table_id,
                "pageNumber": page_number,
                "regionId": region_id,
                "cells": cells_from_rows(rows),
                "summary": text[:500],
                "metadata": {"source": pdf_table["source"]},
            }
        )


def is_synthetic_table(table: dict[str, Any]) -> bool:
    metadata = table.get("metadata")
    return isinstance(metadata, dict) and metadata.get("synthetic") is True


def pdf_text_tables(source_path: Path) -> list[dict[str, Any]]:
    try:
        import pdfplumber
    except ModuleNotFoundError:
        return []

    tables: list[dict[str, Any]] = []
    seen: set[tuple[int, str]] = set()
    try:
        with pdfplumber.open(str(source_path)) as pdf:
            for page_index, page in enumerate(pdf.pages, start=1):
                text = page.extract_text() or ""
                for rows in pipe_table_row_groups(text.splitlines()):
                    add_pdf_text_table(tables, seen, page_index, rows, "pdf_text_pipe_table")
                for raw_table in page.extract_tables() or []:
                    rows = normalize_pdf_table_rows(raw_table)
                    if rows:
                        add_pdf_text_table(tables, seen, page_index, rows, "pdfplumber_extract_tables")
    except Exception:
        return []
    return tables


def add_pdf_text_table(
    tables: list[dict[str, Any]],
    seen: set[tuple[int, str]],
    page_number_value: int,
    rows: list[list[str]],
    source: str,
) -> None:
    if not material_table_rows(rows):
        return
    key = (page_number_value, "\n".join("|".join(row) for row in rows))
    if key in seen:
        return
    seen.add(key)
    tables.append({"pageNumber": page_number_value, "rows": rows, "source": source})


def normalize_pdf_table_rows(raw_table: list[list[Any]]) -> list[list[str]]:
    rows = [
        [normalize_pdf_table_cell(cell) for cell in row]
        for row in raw_table
        if isinstance(row, list)
    ]
    rows = [row for row in rows if any(cell for cell in row)]
    return normalize_table_rows(rows)


def normalize_pdf_table_cell(cell: Any) -> str:
    if cell is None:
        return ""
    return re.sub(r"[ \t]+", " ", str(cell)).strip()


def material_table_rows(rows: list[list[str]]) -> bool:
    material_cells = [
        cell for row in rows for cell in row if re.search(r"[A-Za-z0-9]", str(cell))
    ]
    if len(material_cells) >= 2:
        return True
    return any(len(re.sub(r"[^A-Za-z0-9]+", "", cell)) >= 20 for cell in material_cells)


def pipe_table_row_groups(lines: list[str]) -> list[list[list[str]]]:
    groups = []
    current: list[list[str]] = []
    for line in lines:
        row = pipe_table_row(line)
        if row is None:
            if current:
                groups.append(normalize_table_rows(current))
                current = []
            continue
        current.append(row)
    if current:
        groups.append(normalize_table_rows(current))
    return [group for group in groups if len(group) >= 2 and max((len(row) for row in group), default=0) >= 2]


def pipe_table_row(line: str) -> list[str] | None:
    if "|" not in line:
        return None
    columns = [column.strip() for column in line.split("|")]
    columns = [column for column in columns if column]
    if len(columns) < 2:
        return None
    return columns


def normalize_table_rows(rows: list[list[str]]) -> list[list[str]]:
    width = max((len(row) for row in rows), default=0)
    return [row + [""] * (width - len(row)) for row in rows]


def cells_from_rows(rows: list[list[str]]) -> list[dict[str, Any]]:
    cells = []
    for row_index, row in enumerate(rows):
        for column_index, text in enumerate(row):
            if not text:
                continue
            cells.append({"rowIndex": row_index, "columnIndex": column_index, "text": text})
    return cells


def add_compound_equation_subregions(regions: list[dict[str, Any]]) -> None:
    for region in list(regions):
        if region.get("kind") != "equation" or not isinstance(region.get("box"), dict):
            continue
        text = str(region.get("text") or "").strip()
        box = region["box"]
        if not text or numeric(box.get("height")) is None or float(box["height"]) < 90:
            continue
        segments = compound_equation_segments(text)
        if len(segments) < 2:
            continue
        segment_height = float(box["height"]) / len(segments)
        region_start = region.get("characterStart")
        search_from = 0
        for index, segment in enumerate(segments, start=1):
            segment_start = text.find(segment, search_from)
            if segment_start < 0:
                segment_start = search_from
            segment_end = segment_start + len(segment)
            search_from = segment_end
            subregion = {
                "id": f"{region['id']}_equation_line_{index}",
                "kind": "equation",
                "pageNumber": int(region.get("pageNumber") or 1),
                "text": segment,
                "parentId": str(region["id"]),
                "box": {
                    **box,
                    "y": round_float(float(box["y"]) + segment_height * (index - 1)),
                    "height": round_float(segment_height),
                },
                "metadata": {"synthetic": True, "splitFrom": str(region["id"])},
            }
            if isinstance(region_start, int):
                subregion["characterStart"] = region_start + segment_start
                subregion["characterEnd"] = region_start + segment_end
            regions.append(subregion)


def compound_equation_segments(text: str) -> list[str]:
    split_points = {0, len(text)}
    for pattern in [
        r"\bS\d+\s*\(",
        r"\(\d+\)\s*\+",
        r"\+\s*\d+(?:\.\d+)?\s*\([^)]*\)\s*\+\s*\d",
    ]:
        for match in re.finditer(pattern, text):
            if match.start() > 0:
                split_points.add(match.start())
    raw_segments = [
        text[start:end].strip(" ,")
        for start, end in zip(sorted(split_points), sorted(split_points)[1:])
        if text[start:end].strip(" ,")
    ]
    segments: list[str] = []
    index = 0
    while index < len(raw_segments):
        segment = raw_segments[index]
        if len(segment) < 12 and index + 1 < len(raw_segments):
            segment = f"{segment} {raw_segments[index + 1]}".strip()
            index += 1
        segments.append(segment)
        index += 1
    return segments if 1 < len(segments) <= 8 else []


def add_split_header_subregions(regions: list[dict[str, Any]]) -> None:
    for region in list(regions):
        if region.get("kind") != "header" or not isinstance(region.get("box"), dict):
            continue
        text = str(region.get("text") or "").strip()
        match = re.match(r"^(SEC\.\s*\S+)\s+(.+)$", text)
        if not match:
            continue
        box = region["box"]
        full_width = float(box["width"])
        first_width = min(full_width * 0.3, max(40.0, full_width * len(match.group(1)) / max(1, len(text))))
        gap = min(40.0, full_width * 0.05)
        parts = [
            (match.group(1), float(box["x"]), first_width),
            (
                match.group(2),
                float(box["x"]) + first_width + gap,
                max(1.0, full_width - first_width - gap),
            ),
        ]
        for index, (part_text, x, width) in enumerate(parts, start=1):
            regions.append(
                {
                    "id": f"{region['id']}_header_part_{index}",
                    "kind": "header",
                    "pageNumber": int(region.get("pageNumber") or 1),
                    "text": part_text,
                    "parentId": str(region["id"]),
                    "box": {
                        **box,
                        "x": round_float(x),
                        "width": round_float(width),
                    },
                    "metadata": {"synthetic": True, "splitFrom": str(region["id"])},
                }
            )


def normalize_visual_assets(
    doc_dict: dict[str, Any],
    regions: list[dict[str, Any]],
    pages_by_number: dict[int, dict[str, Any]],
) -> list[dict[str, Any]]:
    assets = []
    for index, item in enumerate(find_labeled_items(doc_dict, {"picture", "figure", "image"}), start=1):
        payload = json.dumps(item, sort_keys=True, default=str).encode("utf-8")
        page = page_number(item)
        box = box_from_item(item, pages_by_number)
        region_id = f"figure_region_{index}"
        figure_region = {
            "id": region_id,
            "kind": "figure",
            "pageNumber": page,
        }
        if box is not None:
            figure_region["box"] = box
        regions.append(figure_region)
        assets.append(
            {
                "id": f"figure_{index}",
                "kind": "figure",
                "pageNumber": page,
                "mediaType": "image/png",
                "checksum": hashlib.sha256(payload).hexdigest(),
                **({"box": box} if box is not None else {}),
                "metadata": {"regionId": region_id},
            }
        )
    return assets


def add_source_image_visual_asset(
    assets: list[dict[str, Any]],
    request: dict[str, Any],
    pages_by_number: dict[int, dict[str, Any]],
) -> None:
    content_type = str(request.get("contentType") or "").split(";")[0].strip()
    if not content_type.startswith("image/"):
        return
    if any(str(asset.get("kind") or "") == "page_image" for asset in assets):
        return

    page_number = min(pages_by_number) if pages_by_number else 1
    asset = {
        "id": f"source_image_page_{page_number}",
        "kind": "page_image",
        "pageNumber": page_number,
        "mediaType": content_type,
        "metadata": {"source": "input_image"},
    }
    checksum = source_image_checksum(request)
    if checksum:
        asset["checksum"] = checksum
    uri = source_image_uri(request)
    if uri:
        asset["uri"] = uri
    assets.insert(0, asset)


def add_source_pdf_visual_assets(
    assets: list[dict[str, Any]],
    request: dict[str, Any],
    pages_by_number: dict[int, dict[str, Any]],
    regions: list[dict[str, Any]],
    body: str,
) -> None:
    content_type = str(request.get("contentType") or "").split(";")[0].strip()
    if content_type != "application/pdf" or assets or not has_visual_reference(body):
        return

    page_numbers = visual_reference_page_numbers(regions)
    if not page_numbers:
        page_numbers = [min(pages_by_number) if pages_by_number else 1]

    checksum = source_file_checksum(request)
    base_uri = source_file_uri(request)
    for page_number in page_numbers:
        asset = {
            "id": f"source_pdf_page_{page_number}",
            "kind": "page_image",
            "pageNumber": page_number,
            "mediaType": "application/pdf",
            "metadata": {"source": "input_pdf_page", "rendered": False},
        }
        if checksum:
            asset["checksum"] = checksum
        if base_uri:
            asset["uri"] = f"{base_uri}#page={page_number}"
        assets.append(asset)


def visual_reference_page_numbers(regions: list[dict[str, Any]]) -> list[int]:
    page_numbers = set()
    for region in regions:
        kind = str(region.get("kind") or "")
        text = str(region.get("text") or "")
        if kind in {"figure", "figure_caption"} or has_visual_reference(text):
            page_numbers.add(int(region.get("pageNumber") or 1))
    return sorted(page_numbers)


def source_image_checksum(request: dict[str, Any]) -> str | None:
    return source_file_checksum(request)


def source_file_checksum(request: dict[str, Any]) -> str | None:
    bytes_base64 = request.get("bytesBase64")
    if isinstance(bytes_base64, str) and bytes_base64:
        try:
            return hashlib.sha256(base64.b64decode(bytes_base64)).hexdigest()
        except Exception:
            return None

    path = source_image_file_path(request)
    if path is None:
        return None
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def source_image_uri(request: dict[str, Any]) -> str | None:
    return source_file_uri(request)


def source_file_uri(request: dict[str, Any]) -> str | None:
    origin_uri = request.get("originUri")
    if isinstance(origin_uri, str) and origin_uri:
        return origin_uri

    path = source_image_file_path(request)
    if path is None:
        return None
    try:
        return path.resolve().as_uri()
    except ValueError:
        return None


def source_image_file_path(request: dict[str, Any]) -> Path | None:
    path = request.get("path")
    if isinstance(path, str) and path:
        file_path = Path(path)
        if local_path_allowed(file_path):
            return file_path

    origin_uri = request.get("originUri")
    if isinstance(origin_uri, str) and origin_uri.startswith("file://"):
        file_path = Path(origin_uri.removeprefix("file://"))
        if local_path_allowed(file_path):
            return file_path
    return None


def link_page_visual_assets(
    pages: list[dict[str, Any]], visual_assets: list[dict[str, Any]]
) -> None:
    page_image_by_page = {
        int(asset.get("pageNumber") or 1): str(asset["id"])
        for asset in visual_assets
        if str(asset.get("kind") or "") == "page_image" and str(asset.get("id") or "")
    }
    for page in pages:
        page_number = int(page.get("pageNumber") or 1)
        if "visualAssetId" not in page and page_number in page_image_by_page:
            page["visualAssetId"] = page_image_by_page[page_number]


def ensure_pages_cover_layout_items(
    pages: list[dict[str, Any]],
    regions: list[dict[str, Any]],
    tables: list[dict[str, Any]],
    visual_assets: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    pages_by_number = {int(page.get("pageNumber") or 1): page for page in pages}
    page_numbers = set(pages_by_number)
    for item in [*regions, *tables, *visual_assets]:
        number = numeric(item.get("pageNumber"))
        if number is not None:
            page_numbers.add(max(1, int(number)))
    if not page_numbers:
        page_numbers.add(1)

    return [
        pages_by_number.get(page_number)
        or {"pageNumber": page_number, "width": 1, "height": 1, "unit": "normalized"}
        for page_number in sorted(page_numbers)
    ]


def has_visual_reference(body: str) -> bool:
    return bool(
        re.search(
            r"\b(fig\.?|figure|chart|diagram|screenshot)\s*\d*\b|\b(see|shown)\s+(the\s+)?(figure|chart|diagram|screenshot|image)\b",
            body,
            re.I,
        )
    )


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


def find_text_items(value: Any) -> list[dict[str, Any]]:
    found = []
    if isinstance(value, dict):
        if is_textual_docling_item(value) and item_text(value) and value.get("prov") is not None:
            found.append(value)
        for child in value.values():
            found.extend(find_text_items(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(find_text_items(child))
    return found


def is_textual_docling_item(item: dict[str, Any]) -> bool:
    label = str(item.get("label") or item.get("type") or item.get("kind") or "").lower()
    if any(non_text_label in label for non_text_label in ["picture", "figure", "image", "table"]):
        return "caption" in label
    return True


def item_text(item: dict[str, Any]) -> str:
    for key in ["text", "content", "markdown", "latex", "orig", "caption"]:
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def region_kind_for_docling_item(item: dict[str, Any], text: str) -> str:
    label = str(item.get("label") or item.get("type") or item.get("kind") or "").lower()
    if "page_header" in label:
        return "header"
    if "page_footer" in label:
        return "footer"
    if "title" in label:
        return "title"
    if "section_header" in label or "heading" in label:
        return "heading"
    if "list" in label:
        return "list"
    if "table" in label:
        return "table"
    if "picture" in label or "figure" in label or "image" in label:
        return "figure"
    if "formula" in label or "equation" in label:
        return "equation"
    if "caption" in label and is_figure_caption(text):
        return "figure_caption"
    if is_figure_caption(text):
        return "figure_caption"
    if is_tableish(text):
        return "table"
    if text.startswith("#"):
        return "heading"
    return "paragraph"


def table_cells(
    table: dict[str, Any], pages_by_number: dict[int, dict[str, Any]]
) -> list[dict[str, Any]]:
    data = table.get("data")
    if not isinstance(data, dict):
        return []
    raw_cells = data.get("table_cells")
    if not isinstance(raw_cells, list):
        raw_cells = data.get("cells")
    if not isinstance(raw_cells, list):
        return []

    cells = []
    for cell in raw_cells:
        if not isinstance(cell, dict):
            continue
        row_index = integer_from_any(
            cell.get("start_row_offset_idx")
            if cell.get("start_row_offset_idx") is not None
            else cell.get("rowIndex")
            if cell.get("rowIndex") is not None
            else cell.get("row_index")
            if cell.get("row_index") is not None
            else cell.get("row")
        )
        column_index = integer_from_any(
            cell.get("start_col_offset_idx")
            if cell.get("start_col_offset_idx") is not None
            else cell.get("columnIndex")
            if cell.get("columnIndex") is not None
            else cell.get("column_index")
            if cell.get("column_index") is not None
            else cell.get("col")
        )
        if row_index is None or column_index is None:
            continue
        parsed_cell = {
            "rowIndex": max(0, row_index),
            "columnIndex": max(0, column_index),
            "text": item_text(cell),
        }
        row_span = span_value(cell, "row")
        column_span = span_value(cell, "col")
        if row_span is not None:
            parsed_cell["rowSpan"] = row_span
        if column_span is not None:
            parsed_cell["columnSpan"] = column_span
        box = box_from_item(cell, pages_by_number)
        if box is not None:
            parsed_cell["box"] = box
        cells.append(parsed_cell)
    return cells


def cells_from_table_text(text: str) -> list[dict[str, Any]]:
    rows = [row for row in text.splitlines() if row.strip()]
    cells = []
    for row_index, row in enumerate(rows):
        columns = [column.strip() for column in re.split(r"\s*\|\s*|\t", row) if column.strip()]
        for column_index, column in enumerate(columns or [row.strip()]):
            cells.append({"rowIndex": row_index, "columnIndex": column_index, "text": column})
    return cells


def span_value(cell: dict[str, Any], axis: str) -> int | None:
    if axis == "row":
        start = integer_from_any(cell.get("start_row_offset_idx"))
        end = integer_from_any(cell.get("end_row_offset_idx"))
    else:
        start = integer_from_any(cell.get("start_col_offset_idx"))
        end = integer_from_any(cell.get("end_col_offset_idx"))
    if start is None or end is None or end <= start:
        return None
    return max(1, end - start)


def box_from_item(
    item: dict[str, Any], pages_by_number: dict[int, dict[str, Any]]
) -> dict[str, Any] | None:
    boxes = []
    direct_box = item.get("bbox")
    direct_page = page_number(item)
    if isinstance(direct_box, dict):
        box = box_from_bbox(direct_box, direct_page, pages_by_number)
        if box is not None:
            boxes.append(box)

    prov = item.get("prov")
    if isinstance(prov, list):
        for entry in prov:
            if not isinstance(entry, dict):
                continue
            bbox = entry.get("bbox")
            if not isinstance(bbox, dict):
                continue
            box = box_from_bbox(bbox, page_number(entry), pages_by_number)
            if box is not None:
                boxes.append(box)
    return union_boxes(boxes)


def box_from_bbox(
    bbox: dict[str, Any], page_number_value: int, pages_by_number: dict[int, dict[str, Any]]
) -> dict[str, Any] | None:
    left = numeric(bbox.get("l") if bbox.get("l") is not None else bbox.get("left") if bbox.get("left") is not None else bbox.get("x"))
    right = numeric(
        bbox.get("r")
        if bbox.get("r") is not None
        else bbox.get("right")
        if bbox.get("right") is not None
        else None
    )
    top = numeric(bbox.get("t") if bbox.get("t") is not None else bbox.get("top") if bbox.get("top") is not None else bbox.get("y"))
    bottom = numeric(
        bbox.get("b")
        if bbox.get("b") is not None
        else bbox.get("bottom")
        if bbox.get("bottom") is not None
        else None
    )
    width_value = numeric(bbox.get("w") if bbox.get("w") is not None else bbox.get("width"))
    height_value = numeric(bbox.get("h") if bbox.get("h") is not None else bbox.get("height"))

    if left is None or top is None:
        return None
    if right is None and width_value is not None:
        right = left + width_value
    if bottom is None and height_value is not None:
        bottom = top + height_value
    if right is None or bottom is None:
        return None

    page = pages_by_number.get(page_number_value)
    page_width = numeric(page.get("width")) if page else None
    page_height = numeric(page.get("height")) if page else None
    unit = str(page.get("unit") or "point") if page else "point"
    coord_origin = str(bbox.get("coord_origin") or bbox.get("origin") or "").upper()
    x = min(left, right)
    raw_width = abs(right - left)

    if coord_origin == "BOTTOMLEFT" and page_height is not None:
        y = max(0.0, page_height - max(top, bottom))
        raw_height = abs(top - bottom)
    else:
        y = min(top, bottom)
        raw_height = abs(bottom - top)

    if raw_width <= 0 or raw_height <= 0:
        return None
    if page_width is not None:
        x = max(0.0, min(x, page_width))
        raw_width = min(raw_width, max(0.0, page_width - x))
    if page_height is not None:
        y = max(0.0, min(y, page_height))
        raw_height = min(raw_height, max(0.0, page_height - y))
    if raw_width <= 0 or raw_height <= 0:
        return None
    return {
        "pageNumber": page_number_value,
        "x": round_float(x),
        "y": round_float(y),
        "width": round_float(raw_width),
        "height": round_float(raw_height),
        "unit": unit,
    }


def union_boxes(boxes: list[dict[str, Any]]) -> dict[str, Any] | None:
    valid_boxes = [box for box in boxes if isinstance(box, dict)]
    if not valid_boxes:
        return None
    first = valid_boxes[0]
    page = int(first.get("pageNumber") or 1)
    unit = str(first.get("unit") or "point")
    same_page_boxes = [
        box
        for box in valid_boxes
        if int(box.get("pageNumber") or 1) == page and str(box.get("unit") or "point") == unit
    ]
    left = min(float(box["x"]) for box in same_page_boxes)
    top = min(float(box["y"]) for box in same_page_boxes)
    right = max(float(box["x"]) + float(box["width"]) for box in same_page_boxes)
    bottom = max(float(box["y"]) + float(box["height"]) for box in same_page_boxes)
    return {
        "pageNumber": page,
        "x": round_float(left),
        "y": round_float(top),
        "width": round_float(right - left),
        "height": round_float(bottom - top),
        "unit": unit,
    }


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


def integer_from_any(value: Any) -> int | None:
    parsed = numeric(value)
    if parsed is None:
        return None
    return int(parsed)


def round_float(value: float) -> float:
    return round(float(value), 6)


def is_tableish(text: str) -> bool:
    if "|" not in text:
        return False
    columns = [column.strip() for column in text.split("|")]
    return sum(1 for column in columns if column) >= 2


def is_figure_caption(text: str) -> bool:
    return bool(re.match(r"^\s*(fig\.?|figure|chart|diagram)\s+\d+", text, re.I))


if __name__ == "__main__":
    raise SystemExit(main())
