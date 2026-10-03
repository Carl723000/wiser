"""Synthetic metadata only. The retained satellite pixels are not test fixtures."""

from copy import deepcopy
import unittest

from report import assess_products, build_workspace_report


SCENE = "SYNTHETIC_SCENE"
DIGEST = "a" * 64


def fixture():
    products = []
    for band in ("B03", "B8A", "SCL", "TCI"):
        channels = 3 if band == "TCI" else 1
        products.append({
            "band": band, "width": 4, "height": 3, "channels": channels,
            "dtype": "uint8" if band in ("SCL", "TCI") else "uint16",
            "sha256": DIGEST, "sha256After": DIGEST, "expectedSha256": DIGEST,
            "sourceScene": SCENE, "sourceBand": band, "readable": True,
            "nativeCrs": "EPSG:32650", "resolution": [20.0, 20.0],
            "nativeBounds": [400000, 4400000, 400080, 4400060],
            "noData": [None] * channels, "scales": [1.0] * channels,
            "offsets": [0.0] * channels,
            "stats": {"min": 2, "max": 9, "validPixels": 12, "noDataPixels": 0},
            "classFrequency": {"4": 8, "6": 4} if band == "SCL" else None,
            "thumbnailUrl": None,
        })
    return products


def issue_codes(products):
    return {issue["code"] for issue in assess_products(products, SCENE)}


class RasterReportTests(unittest.TestCase):
    def test_four_products_are_one_scene_and_preserve_native_metadata(self):
        products = fixture()
        self.assertEqual(assess_products(products, SCENE), [])
        footprint = {"type": "Polygon", "coordinates": [[[115, 40], [116, 40],
                                                            [116, 41], [115, 41], [115, 40]]]}
        result = build_workspace_report(products, scene_id=SCENE, acquired_at=None,
                                        bounds=[115, 40, 116, 41], footprint=footprint)
        self.assertTrue(result["oneSceneOnly"])
        self.assertTrue(result["qualityLayerPresent"])
        self.assertFalse(result["controlPointVerified"])
        self.assertEqual(result["products"][1]["band"], "B8A")
        self.assertEqual(result["products"][0]["scales"], [1.0])
        self.assertEqual(result["products"][0]["noData"], [None])
        self.assertEqual(result["products"][3]["stats"]["validPixels"], 12)
        self.assertEqual(result["products"][3]["channels"], 3)
        self.assertEqual(result["footprint"], footprint)
        self.assertNotIn("expectedSha256", result["products"][0])
        self.assertNotIn("sourceScene", result["products"][0])
        self.assertTrue(any("B08" in text for text in result["limitations"]))
        self.assertTrue(any("真值" in text for text in result["limitations"]))

    def test_no_pixels_is_not_readable_evidence(self):
        products = fixture()
        products[0]["width"] = 0
        self.assertIn("NO_PIXELS", issue_codes(products))

    def test_all_masked_is_not_a_valid_pixel_sample(self):
        products = fixture()
        products[0]["stats"].update(validPixels=0, noDataPixels=12)
        self.assertIn("NO_VALID_PIXELS", issue_codes(products))

    def test_missing_crs_blocks_spatial_readiness(self):
        products = fixture()
        products[0]["nativeCrs"] = None
        self.assertIn("MISSING_CRS", issue_codes(products))

    def test_missing_band_is_explicit(self):
        products = [product for product in fixture() if product["band"] != "B8A"]
        self.assertIn("MISSING_BAND", issue_codes(products))

    def test_b08_cannot_substitute_for_b8a(self):
        products = fixture()
        products[1]["band"] = "B08"
        self.assertIn("MISSING_BAND", issue_codes(products))
        self.assertIn("UNEXPECTED_BAND", issue_codes(products))

    def test_missing_quality_layer_is_explicit(self):
        products = [product for product in fixture() if product["band"] != "SCL"]
        self.assertIn("MISSING_QUALITY_LAYER", issue_codes(products))

    def test_quality_frequency_must_cover_spatial_pixels(self):
        products = fixture()
        products[2]["classFrequency"] = {"4": 8}
        self.assertIn("INVALID_QUALITY_COUNTS", issue_codes(products))

    def test_unknown_scl_class_is_not_silently_coloured(self):
        products = fixture()
        products[2]["classFrequency"] = {"4": 8, "99": 4}
        self.assertIn("UNKNOWN_QUALITY_CLASS", issue_codes(products))

    def test_lost_hash_does_not_default_to_verified(self):
        products = fixture()
        products[0]["expectedSha256"] = None
        self.assertIn("LOST_HASH", issue_codes(products))
        with self.assertRaises(ValueError):
            build_workspace_report(products, scene_id=SCENE, acquired_at=None,
                                   bounds=None, footprint=None)

    def test_hash_changed_during_read_is_separate_from_old_manifest_mismatch(self):
        products = fixture()
        products[0]["sha256After"] = "b" * 64
        self.assertIn("HASH_CHANGED", issue_codes(products))
        self.assertNotIn("HASH_MISMATCH", issue_codes(products))
        products[0]["sha256After"] = DIGEST
        products[0]["expectedSha256"] = "b" * 64
        self.assertIn("HASH_MISMATCH", issue_codes(products))

    def test_unreadable_file_does_not_become_checked(self):
        products = fixture()
        products[0]["readable"] = False
        self.assertIn("UNREADABLE", issue_codes(products))

    def test_source_band_label_must_match_pixels(self):
        products = fixture()
        products[1]["sourceBand"] = "B08"
        self.assertIn("SOURCE_BAND_MISMATCH", issue_codes(products))

    def test_mixed_scene_cannot_be_counted_as_one_scene(self):
        products = fixture()
        products[1]["sourceScene"] = "ANOTHER_SYNTHETIC_SCENE"
        self.assertIn("SCENE_MISMATCH", issue_codes(products))

    def test_grid_mismatch_and_bad_resolution_are_visible(self):
        products = fixture()
        products[1]["nativeBounds"][0] += 20
        self.assertIn("GRID_MISMATCH", issue_codes(products))
        products[1]["resolution"] = [0, 20]
        self.assertIn("INVALID_RESOLUTION", issue_codes(products))

    def test_same_bounds_do_not_hide_different_pixel_transform(self):
        products = fixture()
        for product in products:
            product["transform"] = [20, 0, 400000, 0, -20, 4400060]
        products[1]["transform"][1] = 0.1
        self.assertIn("GRID_MISMATCH", issue_codes(products))

    def test_spatial_pixel_counts_do_not_multiply_by_rgb_channels(self):
        products = fixture()
        products[3]["stats"]["validPixels"] = 36
        self.assertIn("INVALID_PIXEL_COUNTS", issue_codes(products))

    def test_metadata_cardinality_and_duplicate_products_are_rejected(self):
        products = fixture()
        products[3]["scales"] = [1]
        self.assertIn("INVALID_BAND_METADATA", issue_codes(products))
        products.append(deepcopy(products[0]))
        self.assertIn("DUPLICATE_BAND", issue_codes(products))

    def test_missing_or_degenerate_affine_blocks_a_checked_report(self):
        products = fixture()
        self.assertIn("INVALID_TRANSFORM", issue_codes(products))
        for product in products:
            product["transform"] = [20, 20, 400000, 20, 20, 4400060]
        self.assertIn("INVALID_TRANSFORM", issue_codes(products))

    def test_nonfinite_reversed_and_missing_ranges_are_not_valid_statistics(self):
        for change in ({"min": float("nan")}, {"max": float("inf")},
                       {"min": 10, "max": 2}, {"min": None}):
            products = fixture()
            products[0]["stats"].update(change)
            with self.subTest(change=change):
                self.assertIn("INVALID_PIXEL_RANGE", issue_codes(products))

    def test_boolean_pixel_and_scl_counts_are_not_integer_evidence(self):
        products = fixture()
        products[0]["stats"].update(validPixels=True, noDataPixels=11)
        self.assertIn("INVALID_PIXEL_COUNTS", issue_codes(products))
        products[2]["classFrequency"] = {"4": True, "6": 11}
        self.assertIn("INVALID_QUALITY_COUNTS", issue_codes(products))


if __name__ == "__main__":
    unittest.main()
