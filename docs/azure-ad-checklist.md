# Azure AD (Entra) Checklist — legacy rollback gateway

> **Legacy-only:** the variables, redirect URIs, scopes, and secret names below apply to the Docker/FastAPI rollback gateway. They are not a Cloudflare Worker V2 configuration guide. For the implemented Worker V2 configuration boundary, use [v2-foundation.md](v2-foundation.md); execute live staging only through the human-operated [V2 staging acceptance checklist](v2-staging-acceptance-checklist.md).

Use this when setting up the Azure AD app for ConnectwiseMCP.

## App Registration

- Application type: **Web**
- Redirect URIs (Web):
  - `https://connectwisemcp.funcshun.com/oauth/callback`
  - `https://chatgpt.com/connector_platform_oauth_redirect`
  - `https://platform.openai.com/apps-manage/oauth`

## Secrets

- Create a **Client Secret** and store it in `AZURE_CLIENT_SECRET`.

## Scopes

- Default scopes: `openid profile email`
- Optional: define API scopes if you want custom claims/audiences.

## Values to copy into .env

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- Optional: `AZURE_AUDIENCE` (if using a custom API audience)
