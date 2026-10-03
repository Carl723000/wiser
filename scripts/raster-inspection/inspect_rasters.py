"""Read a retained four-product window, preserve hashes, emit local display assets.

This script never opens an original in update mode. No imagery or token is fetched.
Install the geospatial runtime in an isolated environment, not the JS workspace.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

# Set before loading GDAL/PROJ. No .aux.xml sidecars or online projection grids.
os.environ["PROJ_NETWORK"] = "OFF"
os.environ["GDAL_PAM_ENABLED"] = "NO"

import numpy as np
from PIL import Image, PngImagePlugin
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform

from report import REQUIRED_BANDS, RIGHTS, assess_products, build_workspace_report


SCL_LEGEND = {
    0: ("无数据", (0, 0, 0)),
    1: ("饱和或缺陷", (255, 0, 0)),
    2: ("地形投影阴影", (45, 45, 45)),
    3: ("云影", (100, 50, 0)),
    4: ("植被", (0, 160, 70)),
    5: ("非植被", (220, 190, 90)),
    6: ("水体分类", (35, 110, 230)),
    7: ("未分类", (130, 130, 130)),
    8: ("中概率云", (175, 175, 175)),
    9: ("高概率云", (255, 255, 255)),
    10: ("薄卷云", (100, 210, 255)),
    11: ("雪或冰", (240, 150, 255)),
}
PUBLIC_SOURCES = {
    "licence": "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice",
    "classification": "https://sentiwiki.copernicus.eu/web/s2-processing",
    "rasterioRelease": "https://pypi.org/project/rasterio/1.5.2/",
    "rasterMasks": "https://rasterio.readthedocs.io/en/latest/topics/masks.html",
    "rasterWarp": "https://rasterio.readthedocs.io/en/latest/api/rasterio.warp.html",
}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
                    encoding="utf-8")


def numeric_metadata(values):
    """Preserve legitimate nonfinite labels without putting NaN/Infinity in JSON."""
    numbers, kinds = [], []
    for value in values:
        kind = None
        if value is not None and not math.isfinite(value):
            kind = "NaN" if math.isnan(value) else "+Infinity" if value > 0 else "-Infinity"
        numbers.append(None if value is None or kind is not None else float(value))
        kinds.append(kind)
    return numbers, kinds


def source_metadata(path):
    """Read only the saved product XML, without interpreting XML entities."""
    if path is None:
        return None
    content = path.read_bytes()
    if len(content) > 4 * 1024 * 1024 or b"<!DOCTYPE" in content or b"<!ENTITY" in content:
        raise ValueError("UNSUPPORTED_LOCAL_METADATA")
    root = ET.fromstring(content)
    values = {}
    offsets = {}
    for item in root.iter():
        name = item.tag.rsplit("}", 1)[-1]
        if name in ("BOA_QUANTIFICATION_VALUE", "PROCESSING_BASELINE"):
            values[name] = item.text
        elif name == "BOA_ADD_OFFSET":
            offsets[item.attrib["band_id"]] = item.text
    return {"path": str(path), "sha256": sha256(path), "values": values,
            "boaOffsetsByPhysicalBandId": offsets,
            "note": "保存的源产品 XML 与 TIFF scales/offsets 分开；本轮不换算反射率。"}


def read_product(path, band, expected, source_file):
    before = sha256(path)
    with rasterio.open(path, "r") as dataset:
        pixels = dataset.read()
        masks = dataset.read_masks()
        finite = np.isfinite(pixels)
        valid = np.all((masks != 0) & finite, axis=0)
        tags = dataset.tags()
        all_valid_values = pixels[:, valid]
        values, counts = np.unique(pixels[0], return_counts=True) if band == "SCL" else ([], [])
        nodata, nodata_kinds = numeric_metadata(dataset.nodatavals)
        scales, scale_kinds = numeric_metadata(dataset.scales)
        offsets, offset_kinds = numeric_metadata(dataset.offsets)
        product = {
            "band": band,
            "width": dataset.width, "height": dataset.height, "channels": dataset.count,
            "dtype": "/".join(dict.fromkeys(dataset.dtypes)),
            "sha256": before, "sha256After": None,
            "expectedSha256": expected.get("derivedHash"),
            "sourceScene": tags.get("source_product"), "sourceBand": tags.get("source_band"),
            "sourceSha256": tags.get("source_sha256"),
            "sourceSha256FromSavedManifest": source_file.get("sha256"),
            "readable": pixels.shape == (dataset.count, dataset.height, dataset.width),
            "nativeCrs": dataset.crs.to_string() if dataset.crs else None,
            "resolution": list(dataset.res), "nativeBounds": list(dataset.bounds),
            "transform": list(dataset.transform)[:6],
            "noData": nodata, "noDataNonFiniteKinds": nodata_kinds,
            "scales": scales, "scaleNonFiniteKinds": scale_kinds,
            "offsets": offsets, "offsetNonFiniteKinds": offset_kinds,
            "stats": {
                "min": float(all_valid_values.min()) if all_valid_values.size else None,
                "max": float(all_valid_values.max()) if all_valid_values.size else None,
                "validPixels": int(np.count_nonzero(valid)),
                "noDataPixels": int(valid.size - np.count_nonzero(valid)),
            },
            "classFrequency": {str(int(value)): int(count) for value, count in zip(values, counts)}
                              if band == "SCL" else None,
            "thumbnailUrl": None,
            "pixelValueCount": int(pixels.size),
            "zeroValueCount": int(np.count_nonzero(pixels == 0)),
            "saturated65535ValueCount": int(np.count_nonzero(pixels == 65535))
                                       if band in ("B03", "B8A") else None,
            "sourceSpecialValuesFromSavedManifest": expected.get("sourceSpecialValues"),
            "maskFlags": [[flag.name for flag in flags] for flags in dataset.mask_flag_enums],
            "perChannelRange": [
                {"min": float(channel[valid_channel].min()) if valid_channel.any() else None,
                 "max": float(channel[valid_channel].max()) if valid_channel.any() else None}
                for channel, valid_channel in zip(pixels, (masks != 0) & finite)],
            "processingTag": tags.get("processing"), "sensingTimeTag": tags.get("sensing_time"),
            "path": str(path),
        }
        array = {"pixels": pixels, "valid": valid, "crs": dataset.crs,
                 "transform": dataset.transform}
    return product, array


def footprint_for(product, array):
    width, height = product["width"], product["height"]
    corners = [(0, 0), (0, height), (width, height), (width, 0), (0, 0)]
    native = []
    for start, end in zip(corners, corners[1:]):
        for index in range(32):
            fraction = index / 32
            column = start[0] + (end[0] - start[0]) * fraction
            row = start[1] + (end[1] - start[1]) * fraction
            native.append(array["transform"] * (column, row))
    native.append(native[0])
    longitudes, latitudes = transform(array["crs"], "EPSG:4326",
                                     [point[0] for point in native], [point[1] for point in native])
    coordinates = [[float(lon), float(lat)] for lon, lat in zip(longitudes, latitudes)]
    if not all(np.isfinite(coordinates).flat):
        raise ValueError("INVALID_FOOTPRINT")
    bounds = [min(longitudes), min(latitudes), max(longitudes), max(latitudes)]
    return bounds, {"type": "Polygon", "coordinates": [coordinates]}


def thumbnail(product, array, bounds, path):
    """Nearest display reprojection only. Scientific pixels remain in memory/native."""
    west, south, east, north = bounds
    width = 600
    height = max(1, round(width * (north - south) / (east - west)))
    display_transform = from_bounds(*bounds, width, height)
    destination = np.zeros((product["channels"], height, width), dtype=array["pixels"].dtype)
    kwargs = {"src_transform": array["transform"], "src_crs": array["crs"],
              "dst_transform": display_transform, "dst_crs": "EPSG:4326",
              "resampling": Resampling.nearest, "num_threads": 1}
    reproject(array["pixels"], destination, **kwargs)
    alpha = np.zeros((height, width), dtype="uint8")
    reproject(array["valid"].astype("uint8") * 255, alpha, **kwargs)
    band = product["band"]
    display_stretch = None
    if band == "TCI":
        rgb = np.moveaxis(destination, 0, 2).astype("uint8")
    elif band == "SCL":
        rgb = np.zeros((height, width, 3), dtype="uint8")
        for code, (_, colour) in SCL_LEGEND.items():
            rgb[destination[0] == code] = colour
    else:
        low, high = np.percentile(array["pixels"][0][array["valid"]], [2, 98])
        display_stretch = {"percentiles": [2, 98], "encodedDnRange": [float(low), float(high)]}
        gray = np.clip((destination[0].astype("float64") - low) / max(high - low, 1) * 255,
                       0, 255).astype("uint8")
        rgb = np.repeat(gray[:, :, None], 3, axis=2)
    rgba = np.dstack((rgb, alpha))
    png_metadata = PngImagePlugin.PngInfo()
    png_metadata.add_text("Attribution", "Contains modified Copernicus Sentinel data 2026")
    png_metadata.add_text("Source scene", product["sourceScene"])
    png_metadata.add_text("Display", "EPSG:4326; nearest; native original unchanged")
    Image.fromarray(rgba).save(path, pnginfo=png_metadata)
    return {"band": band, "path": str(path), "sha256": sha256(path),
            "width": width, "height": height, "crs": "EPSG:4326", "bounds": bounds,
            "transform": list(display_transform)[:6], "resampling": "nearest",
            "stretch": display_stretch, "rights": RIGHTS}


def pixel_probes(products, arrays, scene_id, acquired_at):
    """Native cell centres and raw values for review; sampled points are not truth."""
    width, height = products[0]["width"], products[0]["height"]
    points = {(round((height - 1) * y), round((width - 1) * x))
              for y in (0.25, 0.5, 0.75) for x in (0.25, 0.5, 0.75)}
    classifications = arrays["SCL"]["pixels"][0]
    for code in sorted(int(key) for key in products[2]["classFrequency"]):
        rows, columns = np.where(classifications == code)
        index = int(np.argmin((rows - height / 2) ** 2 + (columns - width / 2) ** 2))
        points.add((int(rows[index]), int(columns[index])))
    probes = []
    for row, column in sorted(points):
        x, y = arrays["B03"]["transform"] * (column + 0.5, row + 0.5)
        lons, lats = transform(arrays["B03"]["crs"], "EPSG:4326", [x], [y])
        probes.append({"id": f"native-r{row}-c{column}", "row": row, "column": column,
                       "pixelCentreWgs84": [lons[0], lats[0]], "nativeXY": [x, y],
                       "rawValues": {band: arrays[band]["pixels"][:, row, column].tolist()
                                     for band in REQUIRED_BANDS},
                       "sclLabel": SCL_LEGEND[int(classifications[row, column])][0]})
    return {"sceneId": scene_id, "acquiredAt": acquired_at, "probes": probes,
            "selectionRule": "3×3 固定四分位位置，另选每个实际 SCL 类别距离窗口中心最近的像元。",
            "note": "原生像元中心；类别和原始编码值用于读图，不是专业真值或水质结果。"}


def run(input_dir, output_dir, metadata_path):
    if output_dir == input_dir or output_dir.is_relative_to(input_dir):
        raise ValueError("OUTPUT_MUST_NOT_OVERWRITE_INPUT")
    output_dir.mkdir(parents=True, exist_ok=True)
    validation_path = input_dir / "validation.json"
    validation_hash = sha256(validation_path)
    validation = json.loads(validation_path.read_text(encoding="utf-8"))
    selected = validation["selectedProduct"]
    scene_id = selected["productName"]
    acquired_at = selected.get("productContentDate", {}).get("Start")
    expected_by_band = {product["band"]: product for product in validation["rasters"]}
    source_by_band = {product["band"]: product for product in selected["files"]}
    saved_xml = source_metadata(metadata_path)
    original_files_before = sorted(path.name for path in input_dir.iterdir())
    products, arrays, read_issues = [], {}, []
    with rasterio.Env(GDAL_PAM_ENABLED="NO", PROJ_NETWORK="OFF"):
        for band in REQUIRED_BANDS:
            path = input_dir / f"{band.lower()}-20m-native-window.tif"
            try:
                product, array = read_product(path, band, expected_by_band.get(band, {}),
                                              source_by_band.get(band, {}))
            except (OSError, rasterio.errors.RasterioError, ValueError):
                read_issues.append({"code": "UNREADABLE", "band": band})
                continue
            products.append(product)
            arrays[band] = array
        for product in products:
            product["sha256After"] = sha256(Path(product["path"]))
            if product["sourceSha256"] != product["sourceSha256FromSavedManifest"]:
                read_issues.append({"code": "SOURCE_HASH_TAG_MISMATCH", "band": product["band"]})
            if product["sensingTimeTag"] != acquired_at:
                read_issues.append({"code": "ACQUISITION_TAG_MISMATCH", "band": product["band"]})
        issues = read_issues + assess_products(products, scene_id)
        if sha256(validation_path) != validation_hash:
            issues.append({"code": "VALIDATION_CHANGED", "band": None})
        if saved_xml and sha256(metadata_path) != saved_xml["sha256"]:
            issues.append({"code": "SOURCE_METADATA_CHANGED", "band": None})
        bounds, footprint, thumbnails, workspace = None, None, [], None
        if not issues:
            bounds, footprint = footprint_for(products[0], arrays["B03"])
            thumbnail_dir = output_dir / "thumbnails"
            thumbnail_dir.mkdir(exist_ok=True)
            thumbnails = [thumbnail(product, arrays[product["band"]], bounds,
                                    thumbnail_dir / f"{product['band'].lower()}-wgs84.png")
                          for product in products]
            # URLs remain null until the integration owner installs the local-only route.
            workspace = build_workspace_report(products, scene_id=scene_id, acquired_at=acquired_at,
                                               bounds=bounds, footprint=footprint)
            write_json(output_dir / "pixel-probes.json", pixel_probes(products, arrays, scene_id,
                                                                     acquired_at))
        original_files_after = sorted(path.name for path in input_dir.iterdir())
        if original_files_after != original_files_before:
            issues.append({"code": "INPUT_DIRECTORY_CHANGED", "band": None})
            workspace = None
        # Final whole-input hashes also cover thumbnail/probe generation (memory only).
        for product in products:
            final = sha256(Path(product["path"]))
            product["sha256After"] = final
            if final != product["sha256"]:
                issues.append({"code": "HASH_CHANGED", "band": product["band"]})
                workspace = None
    inspection = {
        "schemaVersion": 1, "processingVersion": "goal100-raster-inspection-v1",
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "status": "checked" if not issues else "incomplete", "issues": issues,
        "sceneId": scene_id, "acquiredAt": acquired_at,
        "products": products, "wgs84Bounds": bounds, "footprint": footprint,
        "validation": {"path": str(validation_path), "sha256": validation_hash},
        "sourceMetadata": saved_xml, "rights": RIGHTS, "publicSources": PUBLIC_SOURCES,
        "thumbnails": thumbnails,
        "sclLegend": {str(code): {"label": label, "rgb": colour}
                      for code, (label, colour) in SCL_LEGEND.items()},
        "runtime": {"python": sys.version.split()[0], "rasterio": rasterio.__version__,
                    "gdal": rasterio.__gdal_version__, "proj": rasterio.__proj_version__,
                    "numpy": np.__version__, "PROJ_NETWORK": "OFF", "GDAL_PAM_ENABLED": "NO"},
        "integrity": {"directoryUnchanged": original_files_before == original_files_after,
                      "beforeFiles": original_files_before, "afterFiles": original_files_after},
        "counting": {"originalScenes": 1, "retainedProducts": len(products),
                     "statsUnit": "spatial pixels where every channel mask is valid and finite",
                     "classFrequencyUnit": "all native SCL pixels, including special classes",
                     "valueUnit": "encoded source values; no reflectance or water-quality conversion"},
    }
    write_json(output_dir / "inspection.json", inspection)
    write_json(output_dir / "workspace-raster-report.json", workspace)
    write_json(output_dir / "thumbnail-manifest.json", thumbnails)
    print(json.dumps({"status": inspection["status"], "products": len(products),
                      "issues": issues, "report": str(output_dir / "workspace-raster-report.json")},
                     ensure_ascii=False))
    return 0 if not issues else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--scene-metadata", type=Path)
    arguments = parser.parse_args()
    sys.exit(run(arguments.input_dir.resolve(), arguments.output_dir.resolve(),
                 arguments.scene_metadata.resolve() if arguments.scene_metadata else None))
