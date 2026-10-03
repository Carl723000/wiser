---
title: 数据基座领域架构
description: 数据基座当前的资料权威、接入、探索、访问权限及验证边界。
docType: architecture
scope: data-foundation
status: active
authoritative: true
owner: wiser
language: zh-CN
whenToUse:
  - 修改 Data Foundation DTO、Capability、状态机、权威数据或发布门禁时
  - 实现或审查 data-postgres、对象存储、Worker、投影、API、MCP、Skill 或 Web 时
whenToUpdate:
  - 公开契约、状态转换、权威源、投影或完成边界变化时
checkPaths:
  - packages/data-*/**
  - apps/data-worker/**
  - apps/api/src/data-foundation/**
  - apps/mcp/src/data-foundation/**
  - apps/web/src/app/*/data-foundation/**
  - infrastructure/data-foundation/**
lastReviewedAt: 2026-10-04
lastReviewedCommit: 36ef3149b764099179e3ff29267c31bf7a164064
