# Azure AD (Entra) Checklist

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
