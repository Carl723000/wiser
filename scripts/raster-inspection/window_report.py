"""Pure bounded native-window statistics. No raster runtime, IO or implicit quality policy."""

import math
import re


RULE_VERSION = "native-window-v1"
MAX_SPATIAL_CELLS = 4096
MAX_CHANNEL_VALUES = 24576
MAX_READ_BYTES = 1024 * 1024
MAX_REPORT_BYTES = 8 * 1024 * 1024
HASH = re.compile(r"[0-9a-f]{64}")
SELECTION_KEYS = ("rowStart", "columnStart", "rowCount", "columnCount")


def _integer(value, minimum=0):
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _finite(value):
    try:
        return _number(value) and math.isfinite(value)
    except OverflowError:
        return False


def _text(value):
    return isinstance(value, str) and 0 < len(value.strip()) <= 1024


def validate_grid(grid):
    """Require a nondegenerate finite native grid, independent of projected area eligibility."""
    if not isinstance(grid, dict) or not all(_integer(grid.get(key), 1)
                                             for key in ("width", "height")):
        raise ValueError("INVALID_GRID_DIMENSIONS")
    affine = grid.get("transform")
    if (not _text(grid.get("crs")) or not isinstance(affine, (list, tuple))
            or len(affine) != 6 or not all(_finite(value) for value in affine)):
        raise ValueError("INVALID_GRID_TRANSFORM_OR_CRS")
    a, b, _, d, e, _ = affine
    determinant = a * e - b * d
    if not _finite(determinant) or determinant == 0:
        raise ValueError("INVALID_GRID_DEGENERATE_TRANSFORM")
    return determinant


def _coordinate(grid, column, row):
    a, b, c, d, e, f = grid["transform"]
    try:
        point = [a * column + b * row + c, d * column + e * row + f]
    except OverflowError as error:
        raise ValueError("INVALID_GRID_COORDINATE_OVERFLOW") from error
    if not all(_finite(value) for value in point):
        raise ValueError("INVALID_GRID_COORDINATE_OVERFLOW")
    return point


def validate_selection(grid, selection, *, channels, bytes_per_value=8):
    """Reject invalid/oversize integer windows before any array read; never clip or pad."""
    determinant = validate_grid(grid)
    if (not isinstance(selection, dict) or set(selection) != set(SELECTION_KEYS)
            or not all(_integer(selection.get(key), 1 if key.endswith("Count") else 0)
                       for key in SELECTION_KEYS)):
        raise ValueError("INVALID_WINDOW_SELECTION")
    row, column = selection["rowStart"], selection["columnStart"]
    rows, columns = selection["rowCount"], selection["columnCount"]
    if row + rows > grid["height"] or column + columns > grid["width"]:
        raise ValueError("WINDOW_OUTSIDE_GRID")
    if not _integer(channels, 1) or not _integer(bytes_per_value, 1):
        raise ValueError("INVALID_WINDOW_RESOURCE_SIZE")
    cells, values = rows * columns, rows * columns * channels
    if (cells > MAX_SPATIAL_CELLS or values > MAX_CHANNEL_VALUES
            or values * (bytes_per_value + 1) > MAX_READ_BYTES):
        raise ValueError("WINDOW_LIMIT")
    corners = [(column, row), (column + columns, row),
               (column + columns, row + rows), (column, row + rows), (column, row)]
    factor = grid.get("linearUnitToMetre")
    try:
        area = (abs(determinant) * factor ** 2
                if grid.get("projected") is True and _finite(factor) and factor > 0 else None)
    except OverflowError:
        area = None
    if area is not None and (not _finite(area) or area <= 0):
        area = None
    return {**selection, "spatialCells": cells, "channelValues": values,
            "nativeCrs": grid["crs"],
            "nativeFootprint": [_coordinate(grid, x, y) for x, y in corners],
            "projectedCellAreaM2": area, "areaStatus": "known" if area is not None else "unknown",
            "areaMethod": "native affine determinant times squared linear-unit-to-metre factor"
                          if area is not None else None}


def _grid_key(grid):
    validate_grid(grid)
    return (grid["width"], grid["height"], grid["crs"], tuple(grid["transform"]),
            grid.get("projected"), grid.get("linearUnitToMetre"))


def validate_quality_policy(policy):
    if not isinstance(policy, dict):
        raise ValueError("INVALID_QUALITY_POLICY")
    mode = policy.get("mode")
    if mode == "raw" and set(policy) == {"mode"}:
        return dict(policy)
    classes = policy.get("classes")
    if (mode != "allowClasses" or set(policy) != {"mode", "classes", "ruleVersion"}
            or not _text(policy.get("ruleVersion")) or not isinstance(classes, list)
            or not classes or not all(_integer(code) and code < 12 for code in classes)
            or len(classes) != len(set(classes))):
        raise ValueError("INVALID_QUALITY_POLICY")
    return {"mode": mode, "classes": list(classes), "ruleVersion": policy["ruleVersion"]}


def _encoded(value):
    if not _number(value):
        raise ValueError("INVALID_ENCODED_VALUE")
    if _finite(value):
        return value, None
    if isinstance(value, int):
        raise ValueError("ENCODED_VALUE_OUTSIDE_NUMERIC_RANGE")
    if math.isnan(value):
        return None, "NaN"
    return None, "+Infinity" if value > 0 else "-Infinity"


def _product_key(product):
    return tuple(product.get(key) for key in ("sourceId", "versionId", "assetId"))


def _validate_product(product, grid, selection, scene, date):
    if not isinstance(product, dict) or not all(_text(product.get(key)) for key in
            ("band", "sourceId", "versionId", "assetId", "sceneId", "acquiredAt", "dtype")):
        raise ValueError("UNBOUND_PRODUCT_SOURCE")
    if not all(isinstance(product.get(key), str) and HASH.fullmatch(product[key])
               for key in ("sha256", "sourceSha256")):
        raise ValueError("UNBOUND_PRODUCT_HASH")
    if _grid_key(product.get("grid")) != _grid_key(grid):
        raise ValueError("GRID_MISMATCH")
    if product["sceneId"] != scene:
        raise ValueError("SCENE_MISMATCH")
    if product["acquiredAt"] != date:
        raise ValueError("ACQUISITION_MISMATCH")
    values, masks = product.get("values"), product.get("masks")
    if not isinstance(values, list) or not values or not isinstance(masks, list):
        raise ValueError("INVALID_ARRAY_SHAPE")
    count = len(values)
    if len(masks) != count:
        raise ValueError("INVALID_ARRAY_SHAPE")
    validate_selection(grid, selection, channels=count)
    for key in ("noData", "scales", "offsets"):
        metadata = product.get(key)
        if not isinstance(metadata, list) or len(metadata) != count:
            raise ValueError("INVALID_CHANNEL_METADATA")
        if key == "noData":
            if not all(value is None or _number(value) for value in metadata):
                raise ValueError("INVALID_NODATA_METADATA")
        elif not all(_finite(value) for value in metadata):
            raise ValueError("INVALID_CHANNEL_METADATA")
    for channels, is_mask in ((values, False), (masks, True)):
        for channel in channels:
            if not isinstance(channel, list) or len(channel) != selection["rowCount"]:
                raise ValueError("INVALID_ARRAY_SHAPE")
            for row in channel:
                if not isinstance(row, list) or len(row) != selection["columnCount"]:
                    raise ValueError("INVALID_ARRAY_SHAPE")
                for value in row:
                    if is_mask and (not _integer(value) or value > 255):
                        raise ValueError("INVALID_MASK_BYTE")
                    if not is_mask:
                        _encoded(value)


def _statistics(values, valid_count):
    if not values:
        return {"dataValidCells": valid_count, "selectedCells": 0,
                "min": None, "max": None, "mean": None, "meanStatus": "empty"}
    # Divide before summing so a finite mean does not overflow an intermediate sum.
    try:
        mean = math.fsum(value / len(values) for value in values)
    except OverflowError:
        mean = None
    if mean is not None and not _finite(mean):
        mean = None
    return {"dataValidCells": valid_count, "selectedCells": len(values),
            "min": min(values), "max": max(values), "mean": mean,
            "meanStatus": "known" if mean is not None else "numerical_overflow"}


def summarize_window(grid, selection, products, *, quality_policy, quality=None):
    """Keep encoded values, per-channel masks and each denominator explicit; no scientific approval."""
    policy = validate_quality_policy(quality_policy)
    if not isinstance(products, list) or not products or len(products) > 6:
        raise ValueError("INVALID_PRODUCT_SELECTION")
    if not all(isinstance(product, dict) for product in products):
        raise ValueError("INVALID_PRODUCT_SELECTION")
    if not all(all(_text(product.get(key)) for key in ("sourceId", "versionId", "assetId"))
               for product in products):
        raise ValueError("UNBOUND_PRODUCT_SOURCE")
    keys = [_product_key(product) for product in products]
    if len(set(keys)) != len(keys):
        raise ValueError("DUPLICATE_PRODUCT")
    if policy["mode"] == "allowClasses" and quality is None:
        raise ValueError("MISSING_QUALITY")
    if quality is not None and (not isinstance(quality, dict) or quality.get("band") != "SCL"):
        raise ValueError("INVALID_QUALITY_LAYER")
    scene, date = products[0].get("sceneId"), products[0].get("acquiredAt")
    channel_count = sum(len(product.get("values", []))
                        for product in products if isinstance(product.get("values"), list))
    extra_quality = quality is not None and _product_key(quality) not in keys
    chosen = validate_selection(grid, selection, channels=channel_count + int(extra_quality))
    for product in products:
        _validate_product(product, grid, selection, scene, date)
    if quality is not None:
        _validate_product(quality, grid, selection, scene, date)
        if len(quality["values"]) != 1:
            raise ValueError("INVALID_QUALITY_LAYER")
        for product in products:
            if _product_key(product) == _product_key(quality) and product != quality:
                raise ValueError("INCONSISTENT_QUALITY_BINDING")

    rows, columns, total = selection["rowCount"], selection["columnCount"], chosen["spatialCells"]
    quality_valid, quality_allowed, quality_codes = [], [], []
    all_frequency, valid_frequency, joint_frequency = {}, {}, {}
    quality_mask_invalid = quality_nonfinite = quality_unknown = quality_rejected = 0
    for row in range(rows):
        for column in range(columns):
            valid, code = False, None
            if quality is not None:
                value, nonfinite = _encoded(quality["values"][0][row][column])
                mask = quality["masks"][0][row][column]
                recognized = value is not None and value == int(value) and 0 <= value < 12
                code = int(value) if recognized else None
                valid = bool(mask != 0 and nonfinite is None and recognized)
                quality_mask_invalid += int(mask == 0)
                quality_nonfinite += int(nonfinite is not None)
                quality_unknown += int(nonfinite is None and not recognized)
                if value is not None:
                    frequency_key = str(int(value)) if value == int(value) else str(value)
                    all_frequency[frequency_key] = all_frequency.get(frequency_key, 0) + 1
                if valid:
                    valid_frequency[str(code)] = valid_frequency.get(str(code), 0) + 1
            allowed = (policy["mode"] == "raw" or valid and code in policy["classes"])
            if policy["mode"] != "raw" and valid and not allowed:
                quality_rejected += 1
            quality_valid.append(valid)
            quality_allowed.append(allowed)
            quality_codes.append(code)

    all_data_valid = [True] * total
    any_mask_invalid, any_nonfinite = [False] * total, [False] * total
    public_products = []
    for product in products:
        channels = len(product["values"])
        valid_counts, included_values = [0] * channels, [[] for _ in range(channels)]
        product_data_valid = product_selected = 0
        cells = []
        for row in range(rows):
            for column in range(columns):
                index, encoded = row * columns + column, []
                common_valid = True
                for channel in range(channels):
                    value, nonfinite = _encoded(product["values"][channel][row][column])
                    mask = product["masks"][channel][row][column]
                    valid = mask != 0 and nonfinite is None
                    included = valid and quality_allowed[index]
                    valid_counts[channel] += int(valid)
                    if included:
                        included_values[channel].append(value)
                    common_valid = common_valid and valid
                    any_mask_invalid[index] = any_mask_invalid[index] or mask == 0
                    any_nonfinite[index] = any_nonfinite[index] or nonfinite is not None
                    encoded.append({"value": value, "nonFiniteKind": nonfinite, "finite": nonfinite is None,
                                    "maskByte": mask, "dataValid": valid,
                                    "qualityAllowed": quality_allowed[index], "statisticsIncluded": included})
                all_data_valid[index] = all_data_valid[index] and common_valid
                product_data_valid += int(common_valid)
                product_selected += int(common_valid and quality_allowed[index])
                global_row, global_column = row + selection["rowStart"], column + selection["columnStart"]
                cells.append({"row": global_row, "column": global_column,
                              "center": _coordinate(grid, global_column + 0.5, global_row + 0.5),
                              "channels": encoded})
        labels = [_encoded(value) if value is not None else (None, None) for value in product["noData"]]
        public_products.append({**{key: product[key] for key in (
            "band", "sceneId", "sourceId", "versionId", "assetId", "sha256", "sourceSha256",
            "acquiredAt", "dtype", "scales", "offsets")},
            "noData": [item[0] for item in labels], "noDataNonFiniteKinds": [item[1] for item in labels],
            "channels": channels, "cells": cells,
            "channelStatistics": [_statistics(values, valid_counts[channel])
                                  for channel, values in enumerate(included_values)],
            "allChannelsDataValidCells": product_data_valid,
            "allChannelsSelectedCells": product_selected})
    joint = [valid and allowed for valid, allowed in zip(all_data_valid, quality_allowed)]
    for included, code in zip(joint, quality_codes):
        if included and code is not None:
            joint_frequency[str(code)] = joint_frequency.get(str(code), 0) + 1
    selected = sum(joint)
    area = chosen["projectedCellAreaM2"]
    selected_area = area * selected if area is not None else None
    if selected_area is not None and not _finite(selected_area):
        selected_area = None
    return {"schemaVersion": 1, "ruleVersion": RULE_VERSION, "status": "checked",
            "statisticsStatus": "known" if selected else "empty", "sceneId": scene, "acquiredAt": date,
            "sceneCount": 1, "selection": chosen, "qualityPolicy": policy,
            "qualityApplied": policy["mode"] != "raw", "products": public_products,
            "counts": {"requestedSpatialCells": total, "channelValues": channel_count * total,
                       "separateQualityValues": total if extra_quality else 0,
                       "allProductsDataValidCells": sum(all_data_valid),
                       "qualityLayerValidCells": sum(quality_valid) if quality is not None else None,
                       "qualitySelectedCells": sum(quality_allowed) if policy["mode"] != "raw" else None,
                       "selectedJointCells": selected, "excludedUnionCells": total - selected,
                       "anyDataMaskInvalidCells": sum(any_mask_invalid),
                       "anyDataNonFiniteCells": sum(any_nonfinite),
                       "qualityMaskInvalidCells": quality_mask_invalid if quality is not None else None,
                       "qualityNonFiniteCells": quality_nonfinite if quality is not None else None,
                       "qualityUnknownClassCells": quality_unknown if quality is not None else None,
                       "qualityRejectedCells": quality_rejected if policy["mode"] != "raw" else None},
            "quality": {"allFiniteFrequency": all_frequency, "validFrequency": valid_frequency,
                        "selectedJointFrequency": joint_frequency} if quality is not None else None,
            "projectedSelectedGridAreaM2": selected_area,
            "professionalApproval": False, "controlPointVerified": False,
            "counting": {"window": "native integer rectangle; no polygon/all-touched sampling",
                         "values": "encoded native values; no scale, offset or reflectance conversion",
                         "channelStatistics": "per-channel mask + finite + explicitly selected quality",
                         "jointStatistics": "all requested product channels + selected quality",
                         "reasons": "reason counts may overlap; excludedUnionCells counts each cell once",
                         "area": "projected grid footprint only; not true surface or measured water area"}}
