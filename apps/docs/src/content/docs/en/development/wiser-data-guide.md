---
title: WISER data review and black-odor water sample trial entry
description: Public web links, trial ingestion limits, and AI/MCP OAuth integration status.
docType: runbook
scope: repository
status: active
authoritative: true
owner: wiser
language: en
whenToUse:
  - reviewing WISER data or preparing black-odor water sample trial entry
  - connecting an external MCP client to the public WISER service
whenToUpdate:
  - public entrypoints, data permissions, or OAuth end-to-end acceptance status change
checkPaths:
  - apps/web/src/app/**/oauth/**
  - apps/mcp/src/**
  - supabase/config.toml
lastReviewedAt: 2026-09-26
lastReviewedCommit: 0635f3f684efbbaeacda76618d200458d5511f6c
---

## Web links

These five links use public HTTPS port `7100`. Sign in with your existing WISER account; the application shows only Projects and data that account may access.

| Purpose                    | Web page                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| WISER Portal               | [Open Portal](https://wiser.thuenv.tiangong.world:7100/en)                                |
| Published data catalog     | [Browse catalog](https://wiser.thuenv.tiangong.world:7100/en/data-foundation/catalog)     |
| Cross-source search        | [Search data](https://wiser.thuenv.tiangong.world:7100/en/data-foundation/search)         |
| Explore and check evidence | [Explore data](https://wiser.thuenv.tiangong.world:7100/en/data-foundation/explore)       |
| Trial ingestion operations | [View ingestions](https://wiser.thuenv.tiangong.world:7100/en/data-foundation/ingestions) |

For black-odor water data, confirm your organization and Project, then check source, version, license, security level, and quality state. Trial ingestion is limited to sources approved for your Project and account. Review the resulting operation and quality feedback. Upload or parsing does not publish a source or establish a validated scientific conclusion.

## External AI/MCP connection

**End-to-end status: BLOCKED (2026-09-26).** Public OAuth discovery and authorization entrypoints are enabled. Personal browser approval and denial, a real MCP client's token exchange, and Project-scoped calls have not yet been jointly verified. Health or discovery HTTP 200 is not proof of readiness.

An MCP client supporting OAuth 2.1 authorization code and PKCE S256 connects in this order:

1. Configure Streamable HTTP MCP URL `https://mcp.wiser.thuenv.tiangong.world:7100/mcp`, not the old loopback address.
2. Read protected resource metadata from the 401 `WWW-Authenticate` challenge, discover issuer `https://auth.wiser.thuenv.tiangong.world:7100/auth/v1`, and dynamically register the client's callback. The authorization request needs the exact `resource`, `redirect_uri`, and PKCE S256 challenge.
3. Sign in with your existing personal WISER account in the browser. Review the client and callback host, then explicitly choose one eligible Project, query or ingestion mode, maximum data level, and a 15-minute or one-hour term before approving. You can also deny. Google, GitHub, and other social sign-in providers are not part of this flow.
4. The client receives the authorization code, exchanges it at the public Auth token endpoint, and sends the OAuth Bearer token in the MCP request header. Do not place passwords, codes, or tokens in chat, Tool arguments, or logs.
5. Acceptance must test an allowed Project query, another Project and unselected ingestion being denied, denial yielding no token, and expired or revoked tokens being rejected. With the user's own Session, `GET /api/platform/v1/agent-connections` lists their connections; `POST /api/platform/v1/agent-connections/{connectionId}/revoke` revokes one with a UUID `Idempotency-Key` and empty JSON body.

### Independent checks completed

- Public MCP metadata publishes the exact HTTPS `/mcp` resource and public issuer. An unauthorized `POST /mcp` returns 401 with a `WWW-Authenticate` link to public resource metadata.
- Public authorization server and OIDC discovery plus JWKS are reachable. A PKCE S256 authorization test redirects to WISER browser consent; public dynamic client registration succeeded. The token endpoint accepts POST, but a personal authorization code has not yet been exchanged.
- The browser consent entry uses a relative public-site redirect and anonymous visitors reach the existing password sign-in page. Kong REST and Storage paths on the Auth hostname still return 404. API health and the password sign-in page load. These checks do not prove an actual password login or Project call.

### Self-registration status

Public self-registration was disabled on 2026-09-26 at the deployment owner's explicit request. Production `/auth/v1/settings` returns `disable_signup=true`; persistent GoTrue configuration sets `GOTRUE_DISABLE_SIGNUP=true`, matching `[auth] enable_signup=false` in the repository. A public `POST /auth/v1/signup` returned `422 signup_disabled`. The check contained no password and created no test account.

Email/password sign-in for existing accounts remains enabled. Account, Session, Project and membership counts were unchanged. Contact the Project maintainer for an authorized account-provisioning or invitation workflow; account activation does not grant Project access automatically. These checks do not replace personal sign-in, email invitation or real MCP client end-to-end acceptance.
