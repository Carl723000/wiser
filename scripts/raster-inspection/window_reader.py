"""Read-only native windows from the already retained four-product local manifest.

No browser paths, URLs, remote reads, source modification, resampling or publishing.
"""

import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import sys

os.environ["PROJ_NETWORK"] = "OFF"
os.environ["GDAL_PAM_ENABLED"] = "NO"

import numpy as np
import rasterio
from rasterio.windows import Window

from report import HASH, REQUIRED_BANDS
from window_report import (MAX_READ_BYTES, MAX_REPORT_BYTES, summarize_window,
                           validate_quality_policy, validate_selection)


def sha256(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def _digest(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def serialize_report(result):
    """Use the same exact UTF-8 representation for the size gate and the file output."""
    encoded = (json.dumps(result, ensure_ascii=False, separators=(",", ":"),
                          allow_nan=False) + "\n").encode("utf-8")
    if len(encoded) > MAX_REPORT_BYTES:
        raise ValueError("REPORT_LIMIT")
    return encoded


def _fixed_path(root, value):
    if not isinstance(value, str) or not value or "://" in value:
        raise ValueError("INVALID_INPUT_PATH")
    path = Path(value)
    path = (path if path.is_absolute() else root / path).resolve()
    if path.parent != root:
        raise ValueError("INPUT_PATH_OUTSIDE")
    if path.suffix.lower() not in (".tif", ".tiff") or not path.is_file():
        raise ValueError("INVALID_INPUT_FILE")
    # External masks/overviews/PAM/world files are not signed by this manifest.
    sidecars = [Path(str(path) + suffix) for suffix in (".aux.xml", ".msk", ".ovr")]
    sidecars += [path.with_suffix(suffix) for suffix in (".tfw", ".tifw", ".wld", ".prj", ".rrd")]
    if any(sidecar.exists() for sidecar in sidecars):
        raise ValueError("UNBOUND_DATASET_FILES")
    return path


def _grid(dataset):
    if dataset.crs is None:
        raise ValueError("INVALID_GRID_CRS")
    projected, factor, unit = dataset.crs.is_projected, None, None
    if projected:
        try:
            unit, factor = dataset.crs.linear_units_factor
        except rasterio.errors.CRSError:
            pass
    return {"width": dataset.width, "height": dataset.height,
            "crs": dataset.crs.to_string(), "transform": list(dataset.transform)[:6],
            "projected": projected, "linearUnitToMetre": factor, "linearUnitName": unit}


def read_native_window(input_dir, selection, *, source_id, version_id, quality_policy):
    """Verify source binding and limits, read each native window, then recheck integrity."""
    if not all(isinstance(value, str) and 0 < len(value.strip()) <= 1024
               for value in (source_id, version_id)):
        raise ValueError("UNBOUND_PRODUCT_SOURCE")
    quality_policy = validate_quality_policy(quality_policy)
    root = Path(input_dir).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("INVALID_INPUT_DIRECTORY")
    manifest_path = (root / "validation.json").resolve(strict=True)
    if manifest_path.parent != root or manifest_path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("INVALID_LOCAL_MANIFEST")
    manifest_before = sha256(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("INVALID_LOCAL_MANIFEST")
    entries = manifest.get("rasters")
    source = manifest.get("selectedProduct")
    if not isinstance(source, dict) or not isinstance(source.get("productContentDate"), dict):
        raise ValueError("INVALID_LOCAL_MANIFEST")
    files = source.get("files")
    scene = source.get("productName")
    acquired = source.get("productContentDate", {}).get("Start")
    if (not isinstance(entries, list) or not isinstance(files, list)
            or not isinstance(scene, str) or not scene.strip()
            or not isinstance(acquired, str) or not acquired.strip()):
        raise ValueError("INVALID_LOCAL_MANIFEST")
    if not all(isinstance(entry, dict) for entry in entries + files):
        raise ValueError("INVALID_LOCAL_MANIFEST")
    if not all(isinstance(entry.get("band"), str) for entry in entries + files):
        raise ValueError("INVALID_LOCAL_MANIFEST")
    bands = [entry.get("band") for entry in entries]
    source_bands = [entry.get("band") for entry in files]
    if (len(set(bands)) != len(bands) or len(set(source_bands)) != len(source_bands)):
        raise ValueError("DUPLICATE_PRODUCT")
    if set(bands) != set(REQUIRED_BANDS) or set(source_bands) != set(REQUIRED_BANDS):
        raise ValueError("INCOMPLETE_PRODUCT_SET")
    source_hashes = {entry["band"]: entry.get("sha256") for entry in files}
    if not all(_digest(value) for value in source_hashes.values()):
        raise ValueError("UNBOUND_SOURCE_HASH")
    paths = {entry["band"]: _fixed_path(root, entry.get("path")) for entry in entries}
    if len(set(paths.values())) != len(paths):
        raise ValueError("DUPLICATE_PRODUCT")
    directory_before = sorted(path.name for path in root.iterdir())
    expected = {entry["band"]: entry.get("derivedHash") for entry in entries}
    if not all(_digest(value) for value in expected.values()):
        raise ValueError("UNBOUND_RETAINED_HASH")
    hashes_before = {band: sha256(path) for band, path in paths.items()}
    if hashes_before != expected:
        raise ValueError("HASH_MISMATCH")

    products, reference_grid, read_bytes, channels = [], None, 0, 0
    with rasterio.Env(PROJ_NETWORK="OFF", GDAL_PAM_ENABLED="NO"), ExitStack() as stack:
        datasets = {}
        for band in REQUIRED_BANDS:
            dataset = stack.enter_context(rasterio.open(paths[band], "r"))
            datasets[band] = dataset
            if any(Path(path).resolve() != paths[band] for path in dataset.files):
                raise ValueError("UNBOUND_DATASET_FILES")
            if dataset.count != (3 if band == "TCI" else 1):
                raise ValueError("INVALID_CHANNELS")
            tags = dataset.tags()
            if tags.get("source_product") != scene:
                raise ValueError("SCENE_MISMATCH")
            if tags.get("source_band") != band:
                raise ValueError("SOURCE_BAND_MISMATCH")
            if tags.get("source_sha256") != source_hashes[band]:
                raise ValueError("SOURCE_HASH_TAG_MISMATCH")
            if tags.get("sensing_time") != acquired:
                raise ValueError("ACQUISITION_TAG_MISMATCH")
            grid = _grid(dataset)
            if reference_grid is None:
                reference_grid = grid
            elif grid != reference_grid:
                raise ValueError("GRID_MISMATCH")
            sizes = []
            for dtype in dataset.dtypes:
                numeric = np.dtype(dtype)
                if numeric.kind not in ("i", "u", "f"):
                    raise ValueError("UNSUPPORTED_ENCODED_DTYPE")
                sizes.append(numeric.itemsize)
            chosen = validate_selection(grid, selection, channels=dataset.count,
                                        bytes_per_value=max(sizes))
            channels += dataset.count
            read_bytes += chosen["spatialCells"] * sum(size + 1 for size in sizes)
        validate_selection(reference_grid, selection, channels=channels)
        if read_bytes > MAX_READ_BYTES:
            raise ValueError("WINDOW_LIMIT")
        native_window = Window(selection["columnStart"], selection["rowStart"],
                               selection["columnCount"], selection["rowCount"])
        # All products/tags/grid/limits are checked before the first array read.
        for band in REQUIRED_BANDS:
            dataset = datasets[band]
            values = dataset.read(window=native_window, boundless=False)
            masks = dataset.read_masks(window=native_window, boundless=False)
            products.append({"band": band, "sceneId": scene, "sourceId": source_id,
                             "versionId": version_id, "assetId": paths[band].name,
                             "sha256": hashes_before[band], "sourceSha256": source_hashes[band],
                             "acquiredAt": acquired, "dtype": "/".join(dict.fromkeys(dataset.dtypes)),
                             "grid": reference_grid, "noData": list(dataset.nodatavals),
                             "scales": list(dataset.scales), "offsets": list(dataset.offsets),
                             "values": values.tolist(), "masks": masks.tolist()})
    quality = next(product for product in products if product["band"] == "SCL")
    result = summarize_window(reference_grid, selection, products,
                              quality_policy=quality_policy, quality=quality)
    if {band: sha256(path) for band, path in paths.items()} != hashes_before:
        raise ValueError("HASH_CHANGED")
    if sha256(manifest_path) != manifest_before:
        raise ValueError("VALIDATION_CHANGED")
    if sorted(path.name for path in root.iterdir()) != directory_before:
        raise ValueError("INPUT_DIRECTORY_CHANGED")
    result["integrity"] = {"manifestSha256": manifest_before, "hashesUnchanged": True,
                           "directoryUnchanged": True, "fileHashes": hashes_before}
    result["readBounds"] = {"spatialCellLimit": 4096, "channelValueLimit": 24576,
                            "arrayByteLimit": MAX_READ_BYTES, "arrayBytes": read_bytes,
                            "readMethod": "native window; no out_shape, boundless padding or resampling",
                            "diskIoBoundary": "source block reads and whole-file hash checks may exceed the selected window"}
    serialize_report(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--version-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--pixel", nargs=2, type=int, metavar=("ROW", "COLUMN"))
    selection.add_argument("--window", nargs=4, type=int,
                           metavar=("ROW_START", "COLUMN_START", "ROW_COUNT", "COLUMN_COUNT"))
    quality = parser.add_mutually_exclusive_group(required=True)
    quality.add_argument("--raw", action="store_true")
    quality.add_argument("--quality-classes", nargs="+", type=int)
    parser.add_argument("--quality-rule-version")
    args = parser.parse_args()
    root, output = args.input_dir.resolve(), args.output.resolve()
    if root == output.parent or root in output.parents or output.exists():
        parser.error("OUTPUT_MUST_BE_NEW_AND_OUTSIDE_INPUT")
    if args.quality_classes is not None and not args.quality_rule_version:
        parser.error("QUALITY_RULE_VERSION_REQUIRED")
    if args.raw and args.quality_rule_version:
        parser.error("RAW_DOES_NOT_USE_A_QUALITY_RULE")
    coords = args.window or [*args.pixel, 1, 1]
    chosen = dict(zip(("rowStart", "columnStart", "rowCount", "columnCount"), coords))
    policy = ({"mode": "raw"} if args.raw else
              {"mode": "allowClasses", "classes": args.quality_classes,
               "ruleVersion": args.quality_rule_version})
    try:
        result = read_native_window(root, chosen, source_id=args.source_id,
                                    version_id=args.version_id, quality_policy=policy)
        output.parent.mkdir(parents=True, exist_ok=True)
        encoded = serialize_report(result)
        with output.open("xb") as stream:
            stream.write(encoded)
    except (ValueError, OSError) as error:
        print(json.dumps({"status": "incomplete", "error": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps({"status": result["status"], "sceneCount": result["sceneCount"],
                      "counts": result["counts"], "output": str(output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
