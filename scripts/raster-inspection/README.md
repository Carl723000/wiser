# Retained raster inspection

Read the four local retained products B03, B8A, SCL and TCI plus their saved
`validation.json`. Nothing is downloaded, uploaded, ingested or edited in place.
The script checks every native pixel and before/after SHA-256 against the saved
manifest. B8A is narrow NIR, not B08. Four products represent one scene.

Run the pure synthetic failure tests with Python 3.12 or later:

```sh
python -m unittest discover -s scripts/raster-inspection -p 'test_*.py' -v
```

The read-only inspector needs an isolated geospatial runtime: Rasterio 1.5.2,
NumPy 2 and Pillow. Rasterio 1.5.2 was the latest compatible stable release checked
on 2026-10-02 against [PyPI](https://pypi.org/project/rasterio/1.5.2/).
This tool does not change workspace JavaScript dependencies or lockfiles.

```sh
python scripts/raster-inspection/inspect_rasters.py \
  --input-dir /absolute/path/to/retained-window \
  --output-dir /absolute/path/to/local-inspection \
  --scene-metadata /absolute/path/to/saved-product.xml
```

`PROJ_NETWORK=OFF` and `GDAL_PAM_ENABLED=NO` prevent online projection grids and
PAM sidecar writes. Files are opened only in read mode. Saved product XML is local
evidence; it does not cause any remote request. The output directory must differ
from, and be outside, the input directory.

Outputs:

- `inspection.json`: controlled local report with host paths, source tags,
  native grids, masks, ranges, SCL frequencies, hashes, display processing and
  runtime versions. `validPixels` counts spatial cells whose channel masks are
  valid and values finite; this is not a claim of scientific validity.
- `workspace-raster-report.json`: the shared UI report without host paths.
  `thumbnailUrl` stays null until the integration owner adds a local-only route.
  An incomplete inspection emits null instead of a verified UI report.
- `thumbnail-manifest.json` and four PNGs: EPSG:4326 display grid, nearest
  reprojection, transparent edges. B03/B8A use a documented 2–98 percentile
  display stretch; TCI keeps its RGB values; SCL uses discrete category colours.
  These transformations do not alter native pixels or produce a scientific raster.
- `pixel-probes.json`: deterministic native cell centres and raw values for
  reading the image. Selection is a 3×3 grid plus the nearest central pixel of
  each actual SCL class, deduplicated. These points are not control points or truth.

NoData file labels, GDAL masks and product special codes are separate evidence.
Likewise, TIFF scale/offset tags are separate from product XML BOA metadata; this
tool does not convert reflectance, derive water quality or estimate water area.
SCL is an algorithmic scene classification, not professional approval or truth.
The source and classification definitions are available from
[Copernicus SentiWiki](https://sentiwiki.copernicus.eu/web/s2-processing).

Sentinel display and redistribution are permitted subject to the source notice
and other lawful-use conditions in the
[Sentinel Data Legal Notice](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice).
Derived PNGs embed `Contains modified Copernicus Sentinel data 2026`; display
interfaces should also show that attribution. Generated images and local reports
remain outside the upstream repository. Permission in the source licence does
not perform or authorize publishing from this tool.

## Native pixel and bounded-window inspection

`window_reader.py` reads any selected native pixel or integer rectangle from the
same retained four-product `validation.json`. It checks product/source/acquisition
tags and before/after file and manifest hashes. Paths must resolve inside that
fixed input directory; unsigned masks, overviews, PAM and world-file sidecars are
rejected. This is a local read-only tool, not a new public API or permission grant.

```sh
python scripts/raster-inspection/window_reader.py \
  --input-dir /absolute/path/to/retained-window \
  --source-id existing-local-source --version-id existing-local-version \
  --pixel 731 413 --raw --output /absolute/path/to/new-pixel-report.json

python scripts/raster-inspection/window_reader.py \
  --input-dir /absolute/path/to/retained-window \
  --source-id existing-local-source --version-id existing-local-version \
  --window 641 533 12 17 --quality-classes 4 5 6 \
  --quality-rule-version recorded-example-policy-v1 \
  --output /absolute/path/to/new-window-report.json
```

Indices start at zero; the rectangle is row start, column start, row count and
column count. Every read requires either raw mode or an explicit SCL class policy.
The example class choice is an inspection setting, not scientific quality approval.
Limits are 4,096 spatial cells, 24,576 channel values, 1 MiB of native value/mask
arrays and 8 MiB of final UTF-8 JSON. Output files must be new and outside the input.
Invalid or oversized selections fail before array reads; no clipping, padding,
reprojection or display-image sampling is performed. Rasterio still reads source
blocks, and integrity checks hash whole files, so these are not disk-IO limits;
see [windowed reads](https://rasterio.readthedocs.io/en/stable/topics/windowed-rw.html).

`window_report.py` is pure. Its reports separate spatial cells, channel values,
per-channel data-valid counts, explicit quality selection and joint counts.
Valid zero stays zero; masked zero stays visible but is excluded from statistics.
Nonfinite values use null plus an explicit reason; empty statistics remain null.
The native-window report also preserves nonfinite NoData labels explicitly. The
older display-report contract cannot express those labels, so its inventory gate
rejects that display handoff while the controlled inspection keeps the label kind.
Overlapping invalid reasons are not added together. Scales, offsets and NoData
labels are retained separately; encoded values are not converted to reflectance.
Projected grid area uses the affine determinant and the squared linear-unit
conversion from the installed CRS API. Angular or unknown units leave square
metres unknown; grid footprint is not measured water area or true surface area.
The four products remain one scene. Scientific approval and control-point checks
are not performed. Service authorization, arbitrary polygon AOIs, mixed-grid
resampling and browser selection need their separately governed integration.
