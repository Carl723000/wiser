"""Read-only local manifest adapter; implementation follows Red tests."""

import hashlib

import rasterio


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_native_window(input_dir, selection, *, source_id, version_id, quality_policy):
    raise NotImplementedError("bounded native window read")
