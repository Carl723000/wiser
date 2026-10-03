---
title: Data GraphQL API
description: Data Foundation schema-first GraphQL fields, shared Handler, identity, limits, and mutation semantics.
docType: protocol-reference
scope: data-graphql-api
status: active
authoritative: true
owner: wiser
language: en
whenToUse:
  - when implementing or calling the Data Foundation GraphQL API
whenToUpdate:
  - when SDL, resolvers, Capability mappings, identity, limits, or errors change
checkPaths:
  - apps/api/src/data-foundation/schema.graphql
  - apps/api/src/data-foundation/graphql-module.ts
  - packages/data-contracts/src/capability/**
lastReviewedAt: 2026-10-03
lastReviewedCommit: 36ef3149b764099179e3ff29267c31bf7a164064
