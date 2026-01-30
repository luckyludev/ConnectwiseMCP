# OAuth + Cloudflare (Claude Files)

This folder consolidates the previous Claude OAuth container guidance and assets
into a clearer structure.

- `DEPLOYMENT_GUIDE.md`: Full walkthrough
- `CLAUDE_CODE_INSTRUCTIONS.md`: Step-by-step commands
- `template/`: Unzipped reference template for the OAuth gateway

Note: The live stack in this repo currently uses static token auth + optional
Azure AD JWT validation (see `deploy/http-gateway`). The OAuth template is here
for future integration.
