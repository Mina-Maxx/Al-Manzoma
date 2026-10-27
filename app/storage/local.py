from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO

from app.storage.base import Storage, StorageError, StorageNotFound

_CHUNK = 64 * 1024


class LocalDiskStorage(Storage):
    """Filesystem-backed storage. For tests and local development only.

    Not used in the pilot: the pilot uses GoogleDriveStorage.
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, name: str) -> Path:
        target = (self.root / name).resolve()
        if target != self.root and self.root not in target.parents:
            raise StorageError("resolved path escapes storage root")
        return target

    def put(
        self, stream: BinaryIO, name: str, *, content_type: str | None = None
    ) -> str:
        dest = self._resolve(name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as out:
            shutil.copyfileobj(stream, out, length=_CHUNK)
        return name

    def open(self, ref: str) -> BinaryIO:
        path = self._resolve(ref)
        if not path.is_file():
            raise StorageNotFound(ref)
        return path.open("rb")

    def delete(self, ref: str) -> None:
        path = self._resolve(ref)
        if path.is_file():
            path.unlink()

    def exists(self, ref: str) -> bool:
        return self._resolve(ref).is_file()

    def iter_refs(self) -> Iterator[str]:
        if not self.root.is_dir():
            return
        for path in self.root.rglob("*"):
            if path.is_file():
                yield path.relative_to(self.root).as_posix()
