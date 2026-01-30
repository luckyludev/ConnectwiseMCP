# Copilot Studio + Azure (Internal M365 Only)

This guide explains how to run the ConnectwiseMCP gateway on Azure and connect it to
Copilot Studio using a Power Platform custom connector. It includes an **internal-only**
pattern using Private Endpoints.

## Overview

Copilot Studio uses Power Platform **custom connectors** to call REST APIs. You’ll
create a custom connector that points to the gateway’s `/mcp` endpoint and uses
OAuth 2.0 with Azure AD.

For internal-only access, use **Private Endpoint + disable public network access** on
the Azure App Service hosting the gateway.

## Option A (Recommended): Private Endpoint (Internal Only)

1) **Deploy the gateway to Azure App Service (container)**
   - Build the container from `deploy/http-gateway` and push to ACR.
   - Configure env vars in App Service (no secrets in code).

2) **Add a Private Endpoint** to the App Service
   - Private Endpoint routes traffic over Private Link.
   - Disable public network access on the app.

3) **Private DNS**
   - Add a Private DNS zone for the app hostname and link it to the VNet.

4) **Power Platform VNet access**
   - Your Power Platform environment must be linked to a VNet to reach private endpoints.
   - Check the custom connector VNet limitations for your environment.

5) **Create a Custom Connector** (Power Platform)
   - Security: **OAuth 2.0** with Azure AD.
   - Base URL: your private endpoint hostname.
   - Define a POST action to `/mcp`.

6) **Add an Action in Copilot Studio**
   - Add your custom connector as a tool/action.

## Option B: Public Endpoint + Access Restrictions (Less strict)

You can keep the app public but restrict inbound traffic with App Service access
restrictions. This is weaker than Private Endpoint and easier to misconfigure.

## Custom Connector Details (MCP)

Use **POST** to the gateway’s `/mcp` endpoint. Example body:

```
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

For tool calls, use:

```
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "search_api_endpoints",
    "arguments": {
      "query": "tickets",
      "max_results": 5
    }
  }
}
```

## Azure AD OAuth Notes

- Use OAuth 2.0 with Azure AD in the custom connector security settings.
- Your Azure AD app should be a **Web** app with the gateway callback URL:
  - `https://<your-app>/oauth/callback`

## Internal-Only Checklist

- Private Endpoint enabled
- Public network access disabled
- Power Platform environment linked to VNet
- Custom connector configured with OAuth 2.0 (Azure AD)
