---
title: WISER 资料查阅与黑臭水体样本试录入指南
description: 现网网页入口、样本试录入边界与 AI/MCP OAuth 联调状态。
docType: runbook
scope: repository
status: active
authoritative: true
owner: wiser
language: zh-CN
whenToUse:
  - 在现网查阅资料或准备黑臭水体样本试录入时
  - 将外部 MCP 客户端接入现网 WISER 时
whenToUpdate:
  - 公网入口、数据权限流程或 OAuth 端到端验收状态变化时
checkPaths:
  - apps/web/src/app/**/oauth/**
  - apps/mcp/src/**
  - supabase/config.toml
lastReviewedAt: 2026-09-26
lastReviewedCommit: c0ba77f3
---

## 网页入口

以下五个入口均使用公网 HTTPS `:7100`。登录时请使用本人已有的 WISER 账户；系统只显示当前账户获准的项目和资料。

| 用途           | 网页                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------- |
| WISER 门户     | [打开门户](https://wiser.thuenv.tiangong.world:7100/zh-CN)                                |
| 已发布资料目录 | [查阅目录](https://wiser.thuenv.tiangong.world:7100/zh-CN/data-foundation/catalog)        |
| 跨资料检索     | [检索资料](https://wiser.thuenv.tiangong.world:7100/zh-CN/data-foundation/search)         |
| 探索与核对     | [探索资料](https://wiser.thuenv.tiangong.world:7100/zh-CN/data-foundation/explore)        |
| 试录入任务     | [查看录入任务](https://wiser.thuenv.tiangong.world:7100/zh-CN/data-foundation/ingestions) |

查阅黑臭水体资料时，先确认当前组织和项目，再核对资料来源、版本、许可、安全级别和质量状态。样本试录入只面向本人拥有录入权限、且已获准用于该项目的资料；发起后应检查任务和质量反馈。上传或完成解析不等于资料已获批准发布，不要将试录入结果直接当作已核准的科学结论。

## 外部 AI/MCP 接入

**端到端状态：BLOCKED（截至 2026-09-26）。** 公网 OAuth 发现和授权入口已启用，但尚未取得本人浏览器同意/拒绝、真实 MCP 客户端换取令牌和按项目调用的完整验收证据。健康检查及发现接口 200 不代表正式可用。

支持 OAuth 2.1 授权码与 PKCE S256 的 MCP 客户端按以下顺序接入：

1. 将 Streamable HTTP MCP 地址配置为 `https://mcp.wiser.thuenv.tiangong.world:7100/mcp`。不要填写旧的 `127.0.0.1:13004` 地址。
2. 客户端从 401 的 `WWW-Authenticate` 找到受保护资源元数据，再发现 issuer `https://auth.wiser.thuenv.tiangong.world:7100/auth/v1`，通过动态客户端注册登记自己的回调地址。授权请求须带准确的 `resource`、`redirect_uri` 与 PKCE S256 challenge。
3. 在浏览器用本人已有的 WISER 账户登录。授权页面会显示客户端、回调主机以及本人可授权的项目；明确选择一个项目、查询或录入模式、最高资料级别与 15 分钟或 1 小时有效期，然后点击同意；也可以点击拒绝。此流程不需要 Google、GitHub 等第三方登录。
4. 客户端接收授权码并自行在公网 Auth 令牌端点交换，之后把 OAuth Bearer Token 放在 MCP 请求头。客户端和用户不得把密码、授权码或令牌贴进聊天、工具参数或日志。
5. 验收时分别检查：获准项目的查询成功；另一项目和未选的录入能力被拒；拒绝授权没有令牌；到期、撤销 OAuth consent 或 WISER Agent connection 后的旧令牌被拒。撤销 WISER connection 使用本人 Session 调用 `POST /api/platform/v1/agent-connections/{connectionId}/revoke`，需 UUID `Idempotency-Key` 与空 JSON body；同一用户可用 `GET /api/platform/v1/agent-connections` 查自己的连接。

### 已完成的独立检查

- 公网 MCP 元数据公布准确的 `https://mcp.wiser.thuenv.tiangong.world:7100/mcp` 和公网 HTTPS 授权服务器；未授权 `POST /mcp` 返回 401 及包含公网元数据地址的 `WWW-Authenticate`。
- 公网 OAuth 授权服务器发现、OIDC 发现、JWKS 可访问；授权端点接受带 PKCE S256 的测试请求并重定向到 WISER 浏览器授权入口；公网动态客户端注册成功。令牌端点接受 POST 路由，尚未用本人授权码完成交换。
- 授权入口在公网使用相对跳转，未登录时引导到已有账户的密码登录页。Auth 域名的 Kong REST/Storage 路径仍为 404；API 健康入口和密码登录页可访问。上述检查不替代实际密码登录及项目调用验收。

### 自行注册状态

现网 `/auth/v1/settings` 报告 `disable_signup=false`，运行中的 GoTrue 也配置 `GOTRUE_DISABLE_SIGNUP=false`、邮箱登录开启。网页只展示已有账户登录并不等于认证 API 关闭了自行注册；此前“不提供公众自行注册”的说法不能视为已落实。此次未在缺少账户开通流程核对的情况下修改注册开关，也未创建测试账户。
