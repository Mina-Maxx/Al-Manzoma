from __future__ import annotations

import io

import pytest

from app.storage.base import StorageError, StorageNotFound
from app.storage.local import LocalDiskStorage


def test_local_storage_round_trip(tmp_path):
    storage = LocalDiskStorage(tmp_path)
    ref = storage.put(io.BytesIO(b"hello world"), "company/c1/quarry/q1/doc1")

    assert ref == "company/c1/quarry/q1/doc1"
    assert storage.exists(ref) is True
    assert storage.open(ref).read() == b"hello world"

    storage.delete(ref)
    assert storage.exists(ref) is False
    storage.delete(ref)  # idempotent


def test_local_storage_missing_ref_raises(tmp_path):
    storage = LocalDiskStorage(tmp_path)
    with pytest.raises(StorageNotFound):
        storage.open("does/not/exist")


def test_local_storage_rejects_path_traversal(tmp_path):
    storage = LocalDiskStorage(tmp_path)
    with pytest.raises(StorageError):
        storage.put(io.BytesIO(b"x"), "../escape.txt")
