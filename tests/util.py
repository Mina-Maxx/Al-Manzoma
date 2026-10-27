from __future__ import annotations

import io


def pdf_bytes(size: int = 128) -> bytes:
    header = b"%PDF-1.4\n"
    if size <= len(header):
        return header[:size]
    return header + b"0" * (size - len(header))


def jpeg_bytes(size: int = 128) -> bytes:
    header = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01"
    if size <= len(header):
        return header[:size]
    return header + b"\x00" * (size - len(header))


def png_bytes(size: int = 128) -> bytes:
    header = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    if size <= len(header):
        return header[:size]
    return header + b"\x00" * (size - len(header))


def exe_bytes(size: int = 128) -> bytes:
    return b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff" + b"\x00" * max(
        0, size - 18
    )


def upload_files(name: str, content: bytes, content_type: str = "application/pdf"):
    return {"file": (name, io.BytesIO(content), content_type)}
