# Bounded multibasin readiness processing

This offline processor reads the eight hash-pinned Beijing monthly publications, a selected Haihe policy text, two acquired public report pages and seven selected OSM reference geometries. It does not discover files recursively, fetch provider data, convert binary DOC, write a service or approve real candidates.

The repository's Node 24 runtime and Python standard library are sufficient. No additional dependencies are installed. Pass the controlled research workspace as `DATA_ROOT` through each `--data-root` argument:

```sh
python3 scripts/multibasin-readiness/preflight.py --data-root "$DATA_ROOT"
node scripts/multibasin-readiness/pack.mjs --data-root "$DATA_ROOT"
node scripts/multibasin-readiness/report.mjs --data-root "$DATA_ROOT"
```

Preflight checks original and format-copy hashes, compares every physical OOXML cell and title against the frozen input, retains scoped HTML paragraphs, and checks named OSM identities, exact endpoint stitching and polygon topology. The original ledger is cumulative and scoped to B. Existing binary DOC conversions are pinned and checked; conversion is not rerun.

The journal binds each source to its original hash, input digest and named rule version. `--stop-after 3` simulates a bounded interruption. A normal rerun reuses completed inputs; `--monthly-rule monthly-v2` recomputes the monthly rule dependency and changes each affected record's processing version. The report additionally demonstrates a one-source rule revision against seven unchanged sources without altering the real pack or originals. A failed or interrupted batch does not replace an existing complete pack.

Outputs stay under `outputs/2026-10-02-goal100/b` in the controlled workspace. The pack includes private original paths for local provenance; the integration owner must validate it and strip those paths before a browser boundary. OSM geometries retain their attribution and ODbL terms. Public report redistribution permissions remain unconfirmed.

Quantities count works, fixed source versions, source objects, candidate rows and distinct reference geometries separately. Monthly water quality categories and category intervals are not concentrations or independent sampling counts. Unknown observation counts and spatial density remain null. Region totals overlap and are never summed; 6 × 19 demand slots do not mean 114 datasets.

Focused checks:

```sh
node --test scripts/multibasin-readiness/processor.test.mjs scripts/multibasin-readiness/pack.test.mjs
python3 scripts/multibasin-readiness/preflight_test.py
pnpm --filter @wiser/web exec vitest run src/lib/spatial-readiness.test.ts src/lib/spatial-candidate-review.test.ts src/lib/spatial-version-impact.test.ts src/components/spatial-readiness-panel.test.tsx src/components/spatial-candidate-review.test.tsx
```

`SpatialCandidateReview` permits decisions only in an independent synthetic exercise. The callback identifies the selected original for display-only exercise dependencies; source evidence and real pending review state remain unchanged. Version impacts identify affected records, source objects, positions, demands, regions and topic packages; a new period does not invalidate older records.

The integration owner performs the full project verification, browser acceptance and final Green decision. Local passing tests do not imply target-service ingestion, professional review, release or deployment.
