#!/usr/bin/env python3
import base64
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any


def main() -> int:
    try:
        request = json.load(sys.stdin)
        result = parse_with_markitdown(request)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ModuleNotFoundError as error:
        if error.name == "markitdown":
            print(
                "MarkItDown is not installed. Install it locally with "
                "`python3 -m pip install markitdown[all]` or set RAG_MARKITDOWN_PYTHON "
                "to a Python environment that has markitdown.",
                file=sys.stderr,
            )
            return 2
        raise
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


def parse_with_markitdown(request: dict[str, Any]) -> dict[str, Any]:
    from markitdown import MarkItDown

    source_path, cleanup_dir = materialize_source(request)
    try:
        converter = MarkItDown()
        converted = converter.convert(str(source_path))
        body = str(getattr(converted, "text_content", "") or "")
        return {
            "body": body,
            "metadata": {
                "engine": "markitdown",
                "format": "markdown",
                "sourceContentType": str(request.get("contentType") or ""),
            },
            "warnings": []
            if body.strip()
            else [
                {
                    "code": "markitdown_empty_body",
                    "message": "MarkItDown returned an empty Markdown body.",
                }
            ],
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

    cleanup_dir = tempfile.TemporaryDirectory(prefix="markitdown-rag-")
    temp_dir = Path(cleanup_dir.name)
    suffix = suffix_for_content_type(str(request.get("contentType") or ""))

    bytes_base64 = request.get("bytesBase64")
    if isinstance(bytes_base64, str) and bytes_base64:
        source_path = temp_dir / f"source{suffix}"
        source_path.write_bytes(base64.b64decode(bytes_base64))
        return source_path, cleanup_dir

    text = request.get("text")
    if isinstance(text, str):
        source_path = temp_dir / f"source{suffix or '.txt'}"
        source_path.write_text(text, encoding="utf-8")
        return source_path, cleanup_dir

    raise ValueError(
        "MarkItDown parser requires an allowed path, allowed file:// originUri, bytesBase64, or text."
    )


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


def suffix_for_content_type(content_type: str) -> str:
    mapping = {
        "application/pdf": ".pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "application/vnd.ms-excel.sheet.macroEnabled.12": ".xlsm",
        "application/epub+zip": ".epub",
        "text/html": ".html",
        "application/xhtml+xml": ".html",
        "text/markdown": ".md",
        "text/plain": ".txt",
        "text/csv": ".csv",
        "application/json": ".json",
        "application/xml": ".xml",
        "text/xml": ".xml",
        "application/zip": ".zip",
    }
    return mapping.get(content_type, "")


if __name__ == "__main__":
    raise SystemExit(main())
