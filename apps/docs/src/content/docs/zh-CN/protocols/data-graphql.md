---
title: Data GraphQL API
description: Data Foundation schema-first GraphQL 的字段、统一 Handler、身份、上限与 mutation 语义。
docType: protocol-reference
scope: data-graphql-api
status: active
authoritative: true
owner: wiser
language: zh-CN
whenToUse:
  - 实现或调用 Data Foundation GraphQL API 时
whenToUpdate:
  - SDL、resolver、Capability mapping、身份、上限或错误语义变化时
checkPaths:
  - apps/api/src/data-foundation/schema.graphql
  - apps/api/src/data-foundation/graphql-module.ts
  - packages/data-contracts/src/capability/**
lastReviewedAt: 2026-10-03
lastReviewedCommit: 36ef3149b764099179e3ff29267c31bf7a164064
