"""Synthetic small arrays only; no retained imagery is embedded in these tests."""

from copy import deepcopy
import json
import math
import unittest

from window_report import summarize_window, validate_selection


GRID = {"width": 4, "height": 3, "crs": "EPSG:32650",
        "transform": [20, 0, 400000, 0, -20, 4400060],
        "projected": True, "linearUnitToMetre": 1.0}
WINDOW = {"rowStart": 1, "columnStart": 2, "rowCount": 2, "columnCount": 2}
RAW = {"mode": "raw"}
QUALITY = {"mode": "allowClasses", "classes": [4, 6], "ruleVersion": "synthetic-v1"}


def product(values=None, masks=None, *, band="B03", grid=None):
    values = [[[0, 2], [4, 8]]] if values is None else values
    masks = [[[255, 255], [255, 255]] for _ in values] if masks is None else masks
    return {"band": band, "sceneId": "SYNTHETIC_SCENE", "sourceId": "synthetic-source",
            "versionId": "synthetic-version", "assetId": f"synthetic-{band}",
            "sha256": "a" * 64, "sourceSha256": "b" * 64,
            "acquiredAt": "2026-01-01T00:00:00Z", "dtype": "float64",
            "noData": [None] * len(values), "scales": [1.0] * len(values),
            "offsets": [0.0] * len(values), "grid": deepcopy(grid or GRID),
            "values": values, "masks": masks}


def quality(values=None, masks=None, *, grid=None):
    return product(values or [[[6, 9], [4, 6]]], masks, band="SCL", grid=grid)


class NativeSelectionTests(unittest.TestCase):
    def test_first_and_last_pixel_and_global_window_coordinates(self):
        for row, column in ((0, 0), (2, 3)):
            chosen = validate_selection(GRID, {"rowStart": row, "columnStart": column,
                                             "rowCount": 1, "columnCount": 1}, channels=1)
            self.assertEqual(chosen["spatialCells"], 1)
            self.assertEqual(chosen["nativeFootprint"][0], [400000 + 20 * column,
                                                          4400060 - 20 * row])
        chosen = validate_selection(GRID, WINDOW, channels=3)
        self.assertEqual(chosen["spatialCells"], 4)
        self.assertEqual(chosen["channelValues"], 12)
        self.assertEqual(chosen["nativeFootprint"],
                         [[400040, 4400040], [400080, 4400040], [400080, 4400000],
                          [400040, 4400000], [400040, 4400040]])

    def test_negative_bool_float_zero_overflow_and_outside_are_rejected(self):
        cases = [("rowStart", -1), ("rowStart", True), ("rowStart", 1.0),
                 ("rowStart", 3), ("columnStart", 4), ("rowCount", 0),
                 ("columnCount", 3), ("rowStart", 10 ** 50)]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                selection = dict(WINDOW, **{key: value})
                with self.assertRaises(ValueError):
                    validate_selection(GRID, selection, channels=1)

    def test_limits_are_checked_before_read_and_do_not_silently_clip(self):
        grid = dict(GRID, width=200, height=200)
        with self.assertRaisesRegex(ValueError, "WINDOW_LIMIT"):
            validate_selection(grid, dict(WINDOW, rowCount=65, columnCount=65), channels=1)
        with self.assertRaisesRegex(ValueError, "WINDOW_LIMIT"):
            validate_selection(grid, dict(WINDOW, rowStart=0, columnStart=0,
                                          rowCount=64, columnCount=64), channels=7)
        with self.assertRaisesRegex(ValueError, "WINDOW_LIMIT"):
            validate_selection(grid, dict(WINDOW, rowStart=0, columnStart=0,
                                          rowCount=64, columnCount=64),
                               channels=6, bytes_per_value=64)

    def test_invalid_grid_affine_and_dimensions_are_rejected(self):
        for change in ({"transform": None}, {"transform": [1, 0, 0, 0, 0, 0]},
                       {"transform": [1, 0, 0, 0, math.nan, 0]}, {"width": True},
                       {"height": 0}, {"crs": None}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "GRID"):
                validate_selection(dict(GRID, **change), WINDOW, channels=1)

    def test_sheared_grid_uses_determinant_and_native_footprint(self):
        grid = dict(GRID, transform=[20, 10, 400000, 0, -20, 4400060])
        result = validate_selection(grid, WINDOW, channels=1)
        self.assertEqual(result["projectedCellAreaM2"], 400)
        self.assertEqual(result["nativeFootprint"][0], [400050, 4400040])
        self.assertEqual(result["nativeFootprint"][2], [400110, 4400000])

    def test_linear_unit_conversion_and_unknown_or_angular_area(self):
        feet = validate_selection(dict(GRID, linearUnitToMetre=0.3048), WINDOW, channels=1)
        self.assertAlmostEqual(feet["projectedCellAreaM2"], 400 * 0.3048 ** 2)
        for change in ({"projected": False}, {"linearUnitToMetre": None},
                       {"linearUnitToMetre": math.nan}):
            result = validate_selection(dict(GRID, **change), WINDOW, channels=1)
            self.assertIsNone(result["projectedCellAreaM2"])
            self.assertEqual(result["areaStatus"], "unknown")


class WindowStatisticsTests(unittest.TestCase):
    def summary(self, products, *, policy=RAW, scl=None):
        return summarize_window(GRID, WINDOW, products, quality_policy=policy, quality=scl)

    def test_valid_zero_is_preserved_and_not_converted_using_scale_or_offset(self):
        p = product()
        p["scales"] = [0.01]
        p["offsets"] = [-1000]
        result = self.summary([p])
        channel = result["products"][0]["channelStatistics"][0]
        self.assertEqual(channel["selectedCells"], 4)
        self.assertEqual((channel["min"], channel["max"], channel["mean"]), (0, 8, 3.5))
        sample = result["products"][0]["cells"][0]
        self.assertEqual((sample["row"], sample["column"], sample["center"]),
                         (1, 2, [400050, 4400030]))
        self.assertEqual(sample["channels"][0]["value"], 0)
        self.assertTrue(sample["channels"][0]["statisticsIncluded"])
        self.assertEqual(result["products"][0]["scales"], [0.01])
        self.assertFalse(result["qualityApplied"])

    def test_same_zero_with_invalid_mask_retains_value_but_is_not_counted(self):
        p = product(masks=[[[0, 255], [255, 255]]])
        p["noData"] = [0]
        result = self.summary([p])
        c = result["products"][0]["cells"][0]["channels"][0]
        self.assertEqual((c["value"], c["maskByte"]), (0, 0))
        self.assertFalse(c["statisticsIncluded"])
        self.assertEqual(result["counts"]["selectedJointCells"], 3)

    def test_nonfinite_is_serializable_with_explicit_reason_and_empty_stats_are_null(self):
        result = self.summary([product([[[math.nan, math.inf], [-math.inf, math.nan]]])])
        json.dumps(result, allow_nan=False)
        c = result["products"][0]["cells"][0]["channels"][0]
        self.assertIsNone(c["value"])
        self.assertEqual(c["nonFiniteKind"], "NaN")
        stats = result["products"][0]["channelStatistics"][0]
        self.assertEqual((stats["selectedCells"], stats["min"], stats["max"], stats["mean"]),
                         (0, None, None, None))
        self.assertEqual(result["statisticsStatus"], "empty")

    def test_rgb_counts_spatial_cells_separately_from_channel_values(self):
        rgb = product([[[1, 2], [3, 4]], [[5, 6], [7, 8]], [[9, 10], [11, 12]]],
                      [[[255, 255], [255, 255]], [[255, 255], [255, 255]],
                       [[0, 255], [255, 255]]], band="TCI")
        result = self.summary([rgb])
        self.assertEqual(result["counts"]["requestedSpatialCells"], 4)
        self.assertEqual(result["counts"]["channelValues"], 12)
        self.assertEqual(result["counts"]["allProductsDataValidCells"], 3)
        self.assertEqual([c["dataValidCells"] for c in
                          result["products"][0]["channelStatistics"]], [4, 4, 3])
        self.assertEqual(result["sceneCount"], 1)

    def test_overlapping_mask_nonfinite_and_quality_reasons_do_not_add_denominators(self):
        p = product([[[math.nan, 2], [4, 8]]], [[[0, 255], [255, 255]]])
        result = self.summary([p], policy=QUALITY, scl=quality())
        self.assertEqual(result["counts"]["selectedJointCells"], 2)
        self.assertEqual(result["counts"]["excludedUnionCells"], 2)
        self.assertEqual(result["counts"]["anyDataMaskInvalidCells"], 1)
        self.assertEqual(result["counts"]["anyDataNonFiniteCells"], 1)
        self.assertEqual(result["counts"]["qualityRejectedCells"], 1)

    def test_scl_selection_is_explicit_and_keeps_separate_frequency_sets(self):
        result = self.summary([product()], policy=QUALITY, scl=quality())
        self.assertTrue(result["qualityApplied"])
        self.assertEqual(result["counts"]["qualityLayerValidCells"], 4)
        self.assertEqual(result["counts"]["qualitySelectedCells"], 3)
        self.assertEqual(result["counts"]["selectedJointCells"], 3)
        self.assertEqual(result["quality"]["allFiniteFrequency"], {"6": 2, "9": 1, "4": 1})
        self.assertEqual(result["quality"]["selectedJointFrequency"], {"6": 2, "4": 1})
        self.assertEqual(result["projectedSelectedGridAreaM2"], 1200)
        self.assertFalse(result["professionalApproval"])
        self.assertFalse(result["controlPointVerified"])
        self.assertNotIn("waterArea", result)

    def test_invalid_or_unknown_scl_is_excluded_only_when_quality_selection_is_required(self):
        scl = quality([[[6, 99], [math.nan, 4]]], [[[0, 255], [255, 255]]])
        selected = self.summary([product()], policy=QUALITY, scl=scl)
        self.assertEqual(selected["counts"]["qualityLayerValidCells"], 1)
        self.assertEqual(selected["counts"]["selectedJointCells"], 1)
        raw = self.summary([product()], scl=scl)
        self.assertEqual(raw["counts"]["selectedJointCells"], 4)
        self.assertIsNone(raw["counts"]["qualitySelectedCells"])

    def test_missing_quality_or_unrecorded_policy_does_not_default_to_all_pass(self):
        with self.assertRaisesRegex(ValueError, "MISSING_QUALITY"):
            self.summary([product()], policy=QUALITY)
        for policy in (None, {}, {"mode": "allowClasses", "classes": [6]},
                       dict(QUALITY, classes=[True]), dict(QUALITY, classes=[99])):
            with self.subTest(policy=policy), self.assertRaisesRegex(ValueError, "QUALITY_POLICY"):
                self.summary([product()], policy=policy, scl=quality())

    def test_all_quality_excluded_is_not_zero_valued_measurement(self):
        result = self.summary([product()], policy=dict(QUALITY, classes=[11]), scl=quality())
        self.assertEqual(result["counts"]["selectedJointCells"], 0)
        self.assertEqual(result["projectedSelectedGridAreaM2"], 0)
        self.assertIsNone(result["products"][0]["channelStatistics"][0]["mean"])
        self.assertEqual(result["statisticsStatus"], "empty")

    def test_half_pixel_shift_resolution_scene_and_date_mismatches_reject_joint_read(self):
        cases = [("GRID_MISMATCH", product(grid=dict(GRID, transform=[20, 0, 400010, 0, -20, 4400060]))),
                 ("GRID_MISMATCH", product(grid=dict(GRID, transform=[10, 0, 400000, 0, -10, 4400060]))),
                 ("SCENE_MISMATCH", dict(product(), sceneId="OTHER")),
                 ("ACQUISITION_MISMATCH", dict(product(), acquiredAt="2026-02-01T00:00:00Z"))]
        for code, p in cases:
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, code):
                self.summary([product(band="B8A"), p])
        with self.assertRaisesRegex(ValueError, "GRID_MISMATCH"):
            self.summary([product()], policy=QUALITY, scl=quality(grid=dict(GRID, width=8)))

    def test_ragged_shape_invalid_mask_bool_value_or_unbound_source_rejected(self):
        cases = [dict(product(), values=[[[1], [2, 3]]]),
                 product(masks=[[[256, 255], [255, 255]]]),
                 product([[[True, 2], [3, 4]]]), dict(product(), sha256=None),
                 dict(product(), sourceId=""), dict(product(), scales=[math.inf])]
        for p in cases:
            with self.subTest(product=p), self.assertRaises(ValueError):
                self.summary([p])

    def test_same_source_version_asset_cannot_be_counted_twice(self):
        with self.assertRaisesRegex(ValueError, "DUPLICATE_PRODUCT"):
            self.summary([product(), product()])


if __name__ == "__main__":
    unittest.main()
