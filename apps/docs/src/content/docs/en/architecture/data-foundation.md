---
title: Data Foundation domain architecture
description: Current Data Foundation capabilities, data authority, ingestion, exploration, access, and verification boundaries.
docType: architecture
scope: data-foundation
status: active
authoritative: true
owner: wiser
language: en
whenToUse:
  - when changing Data Foundation DTOs, Capabilities, states, authority, or publication gates
  - when implementing or reviewing data-postgres, object storage, Worker, projections, API, MCP, Skill, or Web
whenToUpdate:
  - when public contracts, transitions, authorities, projections, or completion boundaries change
checkPaths:
  - packages/data-*/**
  - apps/data-worker/**
  - apps/api/src/data-foundation/**
  - apps/mcp/src/data-foundation/**
  - apps/web/src/app/*/data-foundation/**
  - infrastructure/data-foundation/**
lastReviewedAt: 2026-10-04
lastReviewedCommit: 36ef3149b764099179e3ff29267c31bf7a164064
