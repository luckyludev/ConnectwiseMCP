# Claude Setup (MCP Connector)

## Cloudflare Worker V2

Add the canonical Worker `/mcp` URL in Claude under **Customize → Connectors → Add custom connector**, then complete Microsoft Entra sign-in. Do not enter ConnectWise or Cloudflare secrets in Claude; the Worker resolves the authenticated identity's server-side `CW_PROFILE_<ALIAS>` secret.

The connector currently permits bounded reads only. Entra controls who can reach it and selects the immutable profile mapping. Write-capable tools remain registered for compatibility but require `mcp:write`, which the current OAuth flow does not issue, so they are denied before profile-secret access. Do not treat a ConnectWise Security Role as authorization to bypass this Worker scope gate.

### Write tools are disabled

The attachment uploader, ticket-note, ticket/agreement/schedule/time-entry creation, update, and deletion tools cannot be used by a normally authenticated Claude connector in the current release. They are retained in the catalog for compatibility but require the unissued `mcp:write` scope. Do not attempt to enable or test them against live ConnectWise until the separate write authorization and staging gates are reviewed and approved.

Follow the non-secret [V2 staging acceptance checklist](v2-staging-acceptance-checklist.md) before production onboarding.

## Legacy rollback gateway

The Docker/FastAPI gateway is retained only as a controlled, time-bounded rollback path. Do not attach a tunnel or public route, and do not use locally built images for rollback. An authorized operator must activate it from the verified canonical `main` artifact by following the [cutover and rollback runbook](cutover-rollback-runbook.md). Client onboarding occurs only after that procedure establishes the approved endpoint and perimeter controls.

## Local legacy development

Local development may use the gateway on `127.0.0.1`; it is not a production or rollback deployment.

1. Copy `deploy/http-gateway/.env.example` to `deploy/http-gateway/.env` and set strong local values for `MCP_STATIC_TOKEN`, `JWT_SECRET_KEY`, and the required `CONNECTWISE_*` variables.
2. Keep `SERVER_URL` and `MCP_RESOURCE_URL` set to `http://127.0.0.1:8000`.
3. Start only the local gateway service:

   ```bash
   cd deploy/http-gateway
   docker compose up -d --build mcp-gateway
   ```

4. Verify `http://127.0.0.1:8000/health` and add `http://127.0.0.1:8000/sse` to a local Claude client with the local static token.

Never commit the environment file or copy credentials, tokens, or registration responses into logs or issue reports.
