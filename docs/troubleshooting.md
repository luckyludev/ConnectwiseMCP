# Troubleshooting

## Gateway health

- Check health endpoint:
```
curl http://127.0.0.1:8000/health
```

- Logs:
```
docker compose logs -f
```

## OAuth discovery

```
curl https://connectwisemcp.funcshun.com/.well-known/oauth-protected-resource
curl https://connectwisemcp.funcshun.com/.well-known/oauth-authorization-server
```

## Common errors

- **401 / invalid_token**
  - Check `SERVER_URL` and `MCP_RESOURCE_URL` match the public URL.
  - Ensure you are passing a valid Bearer token.

- **OAuth redirect mismatch**
  - Confirm Azure AD redirect URIs include:
    - `https://connectwisemcp.funcshun.com/oauth/callback`
    - `https://chatgpt.com/connector_platform_oauth_redirect`
    - `https://platform.openai.com/apps-manage/oauth`

- **Azure token exchange fails**
  - Verify `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.
  - Ensure the app registration is **Web** and has a valid secret.

- **Tools missing**
  - Check ConnectWise env vars are valid and reachable.
  - Verify database exists in `deploy/cwm-mcp/api_gateway/connectwise_api.db`.
