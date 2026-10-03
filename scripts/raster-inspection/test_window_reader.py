"""Actual window reads of small synthetic GeoTIFFs, never real satellite fixtures."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import rasterio
from rasterio.transform import Affine

import window_reader


SCENE = "SYNTHETIC_SCENE"
DATE = "2026-01-01T00:00:00Z"
SELECTION = {"rowStart": 1, "columnStart": 2, "rowCount": 2, "columnCount": 2}
SOURCE = "synthetic-source"
VERSION = "synthetic-version"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ReaderSpy:
    def __init__(self, dataset, reads):
        self.dataset, self.reads = dataset, reads

    def __getattr__(self, name):
        return getattr(self.dataset, name)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return self.dataset.__exit__(*args)

    def read(self, *args, **kwargs):
        self.reads.append(("values", dict(kwargs)))
        return self.dataset.read(*args, **kwargs)

    def read_masks(self, *args, **kwargs):
        self.reads.append(("masks", dict(kwargs)))
        return self.dataset.read_masks(*args, **kwargs)


class NativeWindowReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wiser-window-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = {"selectedProduct": {"productName": SCENE,
                         "productContentDate": {"Start": DATE}, "files": []},
                         "rasters": []}
        for band in ("B03", "B8A", "SCL", "TCI"):
            channels = 3 if band == "TCI" else 1
            path = self.root / f"{band.lower()}-native.tif"
            values = np.arange(12, dtype="uint16").reshape(3, 4)
            if band == "SCL":
                values = np.full((3, 4), 6, dtype="uint8")
                values[1, 3] = 9
            if band == "TCI":
                values = values.astype("uint8")
            array = np.stack([values + offset for offset in range(channels)])
            with rasterio.open(path, "w", driver="GTiff", width=4, height=3,
                               count=channels, dtype=array.dtype, crs="EPSG:32650",
                               transform=Affine(20, 0, 400000, 0, -20, 4400060)) as ds:
                ds.write(array)
                ds.update_tags(source_product=SCENE, source_band=band,
                               source_sha256="b" * 64, sensing_time=DATE)
            self.manifest["rasters"].append({"band": band, "path": str(path),
                                              "derivedHash": digest(path)})
            self.manifest["selectedProduct"]["files"].append({"band": band, "sha256": "b" * 64})
        self.write_manifest()

    def write_manifest(self):
        (self.root / "validation.json").write_text(json.dumps(self.manifest))

    def read(self, selection=SELECTION, policy=None):
        return window_reader.read_native_window(self.root, selection, source_id=SOURCE,
                                                version_id=VERSION,
                                                quality_policy=policy or {"mode": "raw"})

    def test_actual_read_keeps_global_indices_hashes_and_all_native_values(self):
        before = {path.name: digest(path) for path in self.root.iterdir()}
        result = self.read()
        self.assertEqual(result["counts"]["requestedSpatialCells"], 4)
        self.assertEqual(result["counts"]["channelValues"], 24)
        self.assertEqual(result["sceneCount"], 1)
        self.assertEqual(result["sceneId"], SCENE)
        b03 = next(p for p in result["products"] if p["band"] == "B03")
        self.assertEqual([c["channels"][0]["value"] for c in b03["cells"]], [6, 7, 10, 11])
        self.assertEqual(b03["cells"][0]["center"], [400050, 4400030])
        self.assertEqual(b03["sourceId"], SOURCE)
        self.assertEqual(b03["versionId"], VERSION)
        self.assertEqual(b03["sha256"], self.manifest["rasters"][0]["derivedHash"])
        self.assertEqual(b03["sourceSha256"], "b" * 64)
        self.assertEqual(before, {path.name: digest(path) for path in self.root.iterdir()})
        self.assertTrue(result["integrity"]["directoryUnchanged"])
        self.assertTrue(result["integrity"]["hashesUnchanged"])
        self.assertNotIn(str(self.root), json.dumps(result))

    def test_every_value_and_mask_read_is_windowed_without_display_resampling(self):
        reads, original_open = [], rasterio.open
        def opened(*args, **kwargs):
            self.assertEqual(args[1] if len(args) > 1 else kwargs.get("mode", "r"), "r")
            return ReaderSpy(original_open(*args, **kwargs), reads)
        with patch.object(window_reader.rasterio, "open", side_effect=opened):
            self.read()
        self.assertEqual(len(reads), 8)
        for kind, args in reads:
            with self.subTest(kind=kind):
                window = args["window"]
                self.assertEqual((window.row_off, window.col_off, window.height, window.width),
                                 (1, 2, 2, 2))
                self.assertNotIn("out_shape", args)
                self.assertFalse(args.get("boundless", False))

    def test_invalid_and_over_limit_selections_never_read_arrays(self):
        reads, original_open = [], rasterio.open
        def opened(*args, **kwargs):
            return ReaderSpy(original_open(*args, **kwargs), reads)
        with patch.object(window_reader.rasterio, "open", side_effect=opened):
            for selection in (dict(SELECTION, rowStart=-1), dict(SELECTION, rowCount=65),
                              dict(SELECTION, columnStart=4)):
                with self.subTest(selection=selection), self.assertRaises(ValueError):
                    self.read(selection)
        self.assertEqual(reads, [])

    def test_quality_mask_and_window_denominators_are_recomputed_from_real_values(self):
        result = self.read(policy={"mode": "allowClasses", "classes": [6],
                                  "ruleVersion": "synthetic-policy"})
        self.assertEqual(result["counts"]["qualitySelectedCells"], 3)
        self.assertEqual(result["counts"]["selectedJointCells"], 3)
        self.assertEqual(result["projectedSelectedGridAreaM2"], 1200)
        self.assertEqual(result["quality"]["allFiniteFrequency"], {"6": 3, "9": 1})

    def test_intrinsic_nodata_mask_does_not_turn_missing_value_into_valid_zero(self):
        path = Path(self.manifest["rasters"][0]["path"])
        with rasterio.open(path, "r+") as ds:
            values = ds.read(1)
            values[1, 2] = 0
            ds.write(values, 1)
            ds.nodata = 0
        self.manifest["rasters"][0]["derivedHash"] = digest(path)
        self.write_manifest()
        result = self.read()
        b03 = next(p for p in result["products"] if p["band"] == "B03")
        first = b03["cells"][0]["channels"][0]
        self.assertEqual((first["value"], first["maskByte"]), (0, 0))
        self.assertFalse(first["statisticsIncluded"])
        self.assertEqual(result["counts"]["selectedJointCells"], 3)

    def test_hash_mismatch_and_read_time_hash_change_block_the_result(self):
        self.manifest["rasters"][0]["derivedHash"] = "c" * 64
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "HASH_MISMATCH"):
            self.read()
        path = Path(self.manifest["rasters"][0]["path"])
        self.manifest["rasters"][0]["derivedHash"] = digest(path)
        self.write_manifest()
        original_hash, calls = window_reader.sha256, {}
        def altered_hash(item):
            calls[str(item)] = calls.get(str(item), 0) + 1
            if Path(item) == path and calls[str(item)] > 1:
                return "c" * 64
            return original_hash(item)
        with patch.object(window_reader, "sha256", side_effect=altered_hash):
            with self.assertRaisesRegex(ValueError, "HASH_CHANGED"):
                self.read()

    def test_source_tags_and_acquisition_are_not_replaced_by_caller_labels(self):
        path = Path(self.manifest["rasters"][0]["path"])
        for tags, error in (({"source_sha256": "c" * 64}, "SOURCE_HASH"),
                            ({"source_product": "OTHER"}, "SCENE"),
                            ({"sensing_time": "2026-02-01T00:00:00Z"}, "ACQUISITION")):
            with rasterio.open(path, "r+") as ds:
                ds.update_tags(source_sha256="b" * 64, source_product=SCENE,
                               sensing_time=DATE, **{k: v for k, v in tags.items()
                                                   if k not in ("source_sha256", "source_product", "sensing_time")})
                ds.update_tags(**tags)
            self.manifest["rasters"][0]["derivedHash"] = digest(path)
            self.write_manifest()
            with self.subTest(tags=tags), self.assertRaisesRegex(ValueError, error):
                self.read()

    def test_manifest_cannot_open_files_outside_the_fixed_input_directory(self):
        self.manifest["rasters"][0]["path"] = str(self.root.parent / "outside.tif")
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "INPUT_PATH_OUTSIDE"):
            self.read()

    def test_unsigned_sidecar_or_duplicate_product_cannot_change_statistics(self):
        path = Path(self.manifest["rasters"][0]["path"])
        sidecar = Path(str(path) + ".aux.xml")
        sidecar.write_text("<PAMDataset />")
        with self.assertRaisesRegex(ValueError, "UNBOUND_DATASET_FILES"):
            self.read()
        sidecar.unlink()
        self.manifest["rasters"].append(dict(self.manifest["rasters"][0]))
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "DUPLICATE_PRODUCT"):
            self.read()


if __name__ == "__main__":
    unittest.main()
