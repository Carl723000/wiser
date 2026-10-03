---
title: WISER Design System
description: The current shared visual, interaction, localization, and accessibility rules for WISER products.
docType: design-system
scope: wiser-web
status: active
authoritative: true
owner: wiser
language: en
whenToUse:
  - when creating or changing any WISER page, component, copy, or theme
whenToUpdate:
  - when color, typography, layout, component, interaction, language, or accessibility rules change
checkPaths:
  - apps/web/src/**
  - apps/docs/src/**
lastReviewedAt: 2026-10-04
lastReviewedCommit: 9adf25d4bcdf1fe1b937c9dc0ba99a469e33d67a
---

## Design direction

WISER serves water-system specialists, exercise controllers, and data stewards. The interface has one job: make authority, current state, risk, evidence, and the next safe action immediately legible.

The existing Agent EXCON “water-system instrument panel” becomes the WISER design baseline. It is not a generic SaaS dashboard: abyss colors communicate authority and depth, river teal represents flowing relationships, gauge amber marks attention and human gates, and contours or flow lines appear in one signature atmospheric layer. New systems reuse this language instead of creating another product skin.

## Design tokens

The core palette comes from the current Web application:

| Name       | Base      | Use                                                |
| ---------- | --------- | -------------------------------------------------- |
| Abyss      | `#071a21` | dark canvas and high-authority regions             |
| Channel    | `#0b303a` | raised dark surfaces and channel relationships     |
| River      | `#087f8c` | primary interaction, selection, flow relationships |
| Ripple     | `#5cc7d2` | dark-theme highlight and focus                     |
| Gauge      | `#dfa33e` | attention, human gates, time-sensitive state       |
| Floodplain | `#edf5f6` | light canvas                                       |

Components consume semantic tokens only: `canvas`, `surface`, `text-*`, `accent-*`, `success-*`, `warning-*`, `danger-*`, `border-*`, and `shadow-*`. System pages never introduce another brand palette or use color as the only state signal.

Light and dark are two mappings of the same information hierarchy, not separate designs. The `wiser-theme` preference persists, first use respects the system preference, and an initializer sets `data-theme` before React hydration to avoid flashing.

## Typography and hierarchy

- Display: restrained Iowan Old Style / Source Han Serif-style faces for product theses, page titles, and major stages only.
- Body: IBM Plex Sans / Noto Sans SC / system sans for tasks, explanations, and controls.
- Utility: IBM Plex Mono / system monospace for IDs, times, versions, hashes, metrics, and protocol fields.
- Body text starts at least at 16px with approximately 1.55 line height; density never comes at the cost of readability.
- Chinese is the default language while protocol fields remain English. English pages preserve the same information, routes, actions, and states.

## Layout contract

```text
┌ WISER Portal ─ Data Foundation ─ Agent EXCON ─ Account ─ Theme ─ Language ┐
├ current-system workspace navigation (absent on Portal / Auth) ────────────┤
│                                                    │
│ page thesis + authority/status strip              │
│                                                    │
│ primary workspace                                 │
│ evidence / operations / diagnostics               │
│                                                    │
└ source, authority, version, freshness ─────────────┘
```

- Information hierarchy is `Portal → business system → system workspace → domain object`; object-local tabs never become platform navigation.
- The WISER logo returns to the locale Portal. Portal is not a third system, and Data Foundation precedes Agent EXCON.
- The global shell, system switcher, Project context, theme, and language remain in the same location everywhere. System workspace navigation appears only after entering that system.
- A page identifies the user's object and its authoritative state before metrics or technical detail.
- Lists, catalogs, and runtime views share card, table, filter, pagination, empty, and failure primitives.
- Technical diagnostics may be denser but never dominate the first visual layer of management and business pages.
- Maximum desktop width, a 390px viewport, keyboard navigation, and reduced motion are required acceptance surfaces.

## State and components

Shared components include AppShell, SystemSwitcher, ProjectSwitcher, PageHeader, AuthorityStrip, StatusBadge, MetricCell, DataTable, FilterBar, EmptyState, FailureState, OperationTimeline, EvidenceLink, VersionPicker, ThemeToggle, and LocaleSwitcher.

- Success, warning, failure, waiting, and unknown states use text and shape as well as color.
- Buttons use action verbs, and an action keeps the same name from button to toast.
- Empty states explain the available action; failures state what happened, its impact, and recovery.
- Every visible string exists in both zh-CN and en dictionaries. Components do not scatter hard-coded bilingual ternaries.

## Product-content boundary

- Ordinary pages explain user goal, current state, impact, and next action before implementation architecture.
- Introductions, empty states, and failures do not expose environment variables, internal URLs, HTTP status, raw error codes, DTO/DAL, databases, workers, or operator recovery commands.
- Trace, Span, CRS, version, and hash terminology appears only when the specialist task requires it.
- See [Product interface and content design](/en/development/product-experience/) for naming, public entry, copy, and new-system contracts.

## System adaptation

- Agent EXCON's signature objects are Runs, Receipts, Barriers, and collaboration flows.
- Data Foundation's signature objects are DataItems, Versions, Ingestions, Operations, Lineage, and map layers.
- Both share the shell, tokens, and components without erasing domain vocabulary: one visual state may represent different domain objects.
- Maps, traces, and lineage graphs may use specialized canvases, but their themes, focus, panels, legends, and state semantics still come from the shared system.

The Data map implements this contract through accessible controls rather than canvas color alone. DataItem version links use `aria-current`; the map form pins bbox, immutable Version, and EPSG:4326/4490 source CRS. PostGIS authority, STAC extent, vector MVT, and raster layers each have a text-labeled checkbox, with unavailable layers disabled. Controls continuously show selectedVersion and display-coordinate conversion with position pending independent verification; layer colors read current theme tokens, so light/dark changes never alter authority hierarchy. Browser tiles use same-origin Web paths, keeping server identity and internal GIS origins out of the UI.

For raster-only specialist maps, the requested area controls the initial viewport when no verified feature or STAC extent is present. Existing unavailable-layer indicators remain unchanged; a camera location is not presented as a newly verified spatial feature.

## Acceptance

Every page passes Chinese and English, light and dark, desktop and 390px, keyboard focus, no browser errors, no horizontal overflow, and reduced-motion checks. Screenshot review compares EXCON and Data Foundation together; any local UI that looks like a second product is pulled back into shared tokens or components.

## Current workspace patterns

| Surface           | Primary reading task                                                                | Interaction and trust boundary                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Data exploration  | Search sources, then move among resources, records, maps, relations, and statistics | Keep the same selected source and version across views; counts name their grain, and unknown values stay unknown         |
| Source details    | Read original content before governance metadata                                    | Keep source files, parsed content, quality checks, and permission limits separate                                        |
| Maps and graphs   | Follow a spatial feature or relation back to evidence                               | Use keyboard-operable controls and text alternatives; a rendered position or connection is not professional verification |
| Agent EXCON runs  | Review outcome, team handoffs, evaluation, trace, and replay                        | Evaluation remains authoritative; incomplete telemetry is shown separately                                               |
| Access management | Check present project and resource access before an action                          | Historical approval outcomes are separate from effective access; a grant requires its own review and execution           |

A selected source remains identifiable by name, fixed version, and evidence link. Tables scroll within their panels on small screens; map and graph controls retain visible focus and text labels. On narrow screens, details can move into a non-modal drawer without clearing selection. Graph labels yield to selected evidence when space is limited.

Explanations that help first use belong next to the relevant control or in the shared help disclosure. Current failures, permission denials, and material limitations remain visible. The same task and state have the same meaning in Chinese and English.

For exact route, query, map, and browser-test behavior, use [Frontend development](/en/development/frontend/). For source authority, record identity, spatial accuracy, and review rules, use [Data Foundation architecture](/en/architecture/data-foundation/). User-facing naming and state language are defined in [Product interface and content design](/en/development/product-experience/).

The local spatial workbench reuses shared themes, fullscreen and contextual help. Region, fixed version, unknown location, reference extent and exercise status use text as well as visual cues. Map and list share selection; comparison panes retain independent cameras. A no-WebGL planar fallback is explicit. Screen-coordinate precision supports consistent rendering without changing source precision.

Planar fallback and WebGL maps identify a selected geometry by both record and position. Other positions of the same record retain their ordinary style; a record-only or unavailable position selection does not highlight a geometry. Keyboard selection preserves the exact pair and clearing the selection restores ordinary styling without modifying source geometry.

At widths up to 1100 px or heights up to 500 px, the local spatial workbench exposes one named Map, Results or Evidence reading pane. Hidden panes remain mounted to retain map state and reading position, while their controls leave keyboard navigation. Tabs support arrows, Home and End. Selecting a result opens its evidence, and locating an evidenced position returns to the same map. Resizing keeps a focused reading control visible; desktop retains its concurrent layout.

Evidence dossiers show source/provider, native time, original values, review state, conditions of use and location limits before technical references. Full fixed-version IDs, original hashes, processing IDs, location coordinate systems and mapped missing-reason codes remain exact in closed technical disclosures. Result cards show source/provider and review status. Identity explanations use pointer-, keyboard- and touch-accessible help; limitations never depend on that help.

Readiness cards use text-backed fact-availability badges and shared semantic tokens. The focused inspector groups source references, records and workflow facts separately, with bounded lists and scrollable coverage tables. Help remains keyboard/touch accessible; missing tasks and invalid coverage input stay visible. Chinese/English, light/dark and 390px/desktop surfaces share the same facts and actions.

Spatial results use separately paged located, unresolved and outside-extent tables, with up to 40 records per page. Original time range, precision and role, original value and unit, source/provider, review state and displayable location evidence remain distinct. Map, evidence and fullscreen transitions retain the reading page and exact selection; changing result scope resets the page. The bounded, keyboard-focusable table scrolls inside its panel, with a fixed object column on narrow screens. Withdrawn records disappear from mounted results; unknowns and valid zero values are not conflated.

Fixed-input dependency checks accept explicit record sets or an exact record/position set for source and rule corrections. They evaluate the complete permitted input and keep unrelated records and positions unchanged; an empty scope never falls back to the entire source. Permission withdrawal or a missing fixed source remains source-wide. The synthetic exercise uses the same complete-input check, without editing or persisting real source content. This local dependency result does not establish an authenticated correction workflow.

## Candidate material reader

Intake detail presents pending-review candidate materials through named Originals, Records and Map tabs. Whole-batch known totals, unparsed originals, loaded geometry records and drawing parts have distinct labels; independent observations remain unestablished. Null, zero, empty text and absent fields have different visible representations. Shared semantic tokens, wrapping controls, internal table scrolling, 44px action targets and contextual help support both locales and narrow layouts. Pending review, unknown position role/scale and current failures stay visible.

The existing map accepts a private display collection without published-version identities. Candidate selection highlights only a member record in the current geometry page; collection parts retain the same record, and clearing restores ordinary drawing. This is reading focus, not positional verification. Full-workspace expansion keeps the reader mounted, confines keyboard focus and restores focus/scroll on exit. Saved-view controls create, list, reopen and revoke through the service, with no browser content archive. These implementation and synthetic behavior checks require separate real browser/theme/390px acceptance.

Original links from a reopened saved view retain its canonical `savedViewId` on both asset cards and selected records, alongside the fixed candidate and asset, so the server can check the full manifest. Direct candidate reading keeps its single-original link without a saved-view identity.

Candidate tabs have stable labelled panels. The inactive map stays mounted but hidden, and its controls stay outside keyboard navigation. Returning to the same fixed candidate, asset, CRS and native drawing preserves the current map instance and reading camera even when a newly authorized response has a new cursor. Changed candidate identity, asset or drawing and denied access remove the previous drawing. Only this bounded in-memory display source is retained; fresh server reads and full saved-manifest checks remain mandatory. This tab recovery does not apply a persisted saved camera or period, and actual browser layout/camera acceptance is separate.
