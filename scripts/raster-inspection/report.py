"""Deterministic inspection gates; no raster runtime, network, or data writes."""

import math
import re


REQUIRED_BANDS = ("B03", "B8A", "SCL", "TCI")
HASH = re.compile(r"[0-9a-f]{64}")
RIGHTS = {
    "displayAllowed": True,
    "redistributionAllowed": True,
    "note": "Contains modified Copernicus Sentinel data 2026. 依 Sentinel Data Legal Notice "
            "保留来源与修改说明；无适用性担保。本轮仅在本地显示派生缩略图。",
}
LIMITATIONS = [
    "仅一个 Sentinel-2 L2A 场景；四个产品不是四次独立观测，不能说明区域或历史覆盖。",
    "B8A 是窄近红外波段，不是 B08；B03/B8A 以保留的 R20m 产品网格检查。",
    "SCL 是场景分类输出，不是真值；类别 6 不能直接作为实测水面或面积依据。",
    "原生网格为 20 m；缩略图的经纬度显示网格和拉伸只用于查看，不改变原件。",
    "GDAL scales/offsets 仅描述文件标签；原始编码值不等于已换算的地表反射率。",
    "NoData 标签与源产品特殊编码分开记录；缺少 NoData 标签不表示每个像元科学有效。",
    "像元可读、哈希一致与地图可显示分别核查；未做控制点对齐或专业审核。",
    "未执行水质反演、水体真值验证、指数趋势或新遥感采集。",
]


def _positive_number(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value > 0)


def assess_products(products, scene_id):
    """Return stable failure codes. Every count is spatial pixels, not RGB values."""
    issues = []

    def add(code, band=None):
        issues.append({"code": code, "band": band})

    bands = [product.get("band") for product in products]
    for band in REQUIRED_BANDS:
        if band not in bands:
            add("MISSING_BAND", band)
        if bands.count(band) > 1:
            add("DUPLICATE_BAND", band)
    if "SCL" not in bands:
        add("MISSING_QUALITY_LAYER", "SCL")
    reference_grid = None
    for product in products:
        band = product.get("band")
        if band not in REQUIRED_BANDS:
            add("UNEXPECTED_BAND", band)
        if not product.get("readable"):
            add("UNREADABLE", band)
        width, height = product.get("width", 0), product.get("height", 0)
        dimensions_valid = (isinstance(width, int) and isinstance(height, int)
                            and not isinstance(width, bool) and not isinstance(height, bool)
                            and width > 0 and height > 0)
        if not dimensions_valid:
            add("NO_PIXELS", band)
        channels = product.get("channels")
        if channels != (3 if band == "TCI" else 1):
            add("INVALID_CHANNELS", band)
        if not product.get("nativeCrs"):
            add("MISSING_CRS", band)
        resolution = product.get("resolution")
        if (not isinstance(resolution, (list, tuple)) or len(resolution) != 2
                or not all(_positive_number(value) for value in resolution)):
            add("INVALID_RESOLUTION", band)
        else:
            grid = (width, height, product.get("nativeCrs"), tuple(resolution),
                    tuple(product.get("nativeBounds", [])), tuple(product.get("transform", [])))
            if reference_grid is None:
                reference_grid = grid
            elif grid != reference_grid:
                add("GRID_MISMATCH", band)
        if not product.get("sourceScene") or product["sourceScene"] != scene_id:
            add("SCENE_MISMATCH", band)
        if product.get("sourceBand") != band:
            add("SOURCE_BAND_MISMATCH", band)
        digests = [product.get(key) for key in ("sha256", "sha256After", "expectedSha256")]
        if not all(isinstance(value, str) and HASH.fullmatch(value) for value in digests):
            add("LOST_HASH", band)
        else:
            if digests[0] != digests[1]:
                add("HASH_CHANGED", band)
            if digests[0] != digests[2]:
                add("HASH_MISMATCH", band)
        for key in ("noData", "scales", "offsets"):
            values = product.get(key)
            if not isinstance(values, list) or len(values) != channels:
                add("INVALID_BAND_METADATA", band)
                break
        stats = product.get("stats", {})
        valid, missing = stats.get("validPixels", 0), stats.get("noDataPixels", 0)
        if not isinstance(valid, int) or valid <= 0:
            add("NO_VALID_PIXELS", band)
        if (not isinstance(valid, int) or not isinstance(missing, int) or missing < 0
                or valid < 0 or dimensions_valid and valid + missing != width * height):
            add("INVALID_PIXEL_COUNTS", band)
        if band == "SCL":
            frequency = product.get("classFrequency")
            if not frequency:
                add("MISSING_QUALITY_LAYER", band)
            else:
                if any(key not in {str(number) for number in range(12)} for key in frequency):
                    add("UNKNOWN_QUALITY_CLASS", band)
                if (not all(isinstance(count, int) and count >= 0 for count in frequency.values())
                        or sum(frequency.values()) != width * height):
                    add("INVALID_QUALITY_COUNTS", band)
    return issues


def build_workspace_report(products, *, scene_id, acquired_at, bounds, footprint,
                           source_id="sentinel2-guanting-20260824"):
    """Only verified inventory can be handed to the local UI. No host paths leak."""
    if assess_products(products, scene_id):
        raise ValueError("RASTER_INSPECTION_INCOMPLETE")
    public_products = []
    for product in products:
        public = {key: product[key] for key in (
            "band", "width", "height", "channels", "dtype", "sha256", "readable",
            "nativeCrs", "resolution", "noData", "scales", "offsets", "stats",
            "classFrequency", "thumbnailUrl",
        )}
        public["hashMatches"] = True
        public_products.append(public)
    return {
        "id": "guanting-native-pixel-inspection-v1",
        "sourceId": source_id,
        "versionId": "20260824-retained-window-inspection-v1",
        "sceneId": scene_id,
        "acquiredAt": acquired_at,
        "regionIds": ["bth", "yongding"],
        "title": "官厅水库 Sentinel-2 保留影像检查（2026-08-24）",
        "products": public_products,
        "wgs84Bounds": bounds,
        "footprint": footprint,
        "qualityLayerPresent": True,
        "oneSceneOnly": True,
        "controlPointVerified": False,
        "rights": dict(RIGHTS),
        "limitations": list(LIMITATIONS),
    }
