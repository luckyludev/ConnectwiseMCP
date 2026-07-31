# Legacy MCP read-surface migration classification

> **Status:** decision record for Worker V2. It is not a compatibility promise. The active legacy implementation is `deploy/cwm-mcp/api_gateway/server.py`; `server-beforeproject changes.py` is archival and is not part of this inventory.

## Decision rules

V2 must not accept caller-selected ConnectWise hosts, endpoints, methods, raw requests, conditions, credential headers, profile aliases, or query/body templates. A V2 tool is eligible only when it uses a fixed route, fixed HTTP method, server-controlled bounds, an allowlisted output schema, sanitized failures, `mcp:read` before profile-secret resolution, and request-scoped credentials selected from verified Entra identity.

Read access does **not** automatically justify returning user-authored text, commercial data, attachment metadata, links, or binary content. Audit events must never contain tool arguments, record IDs, content, URLs, credentials, tokens, headers, upstream bodies, or raw errors.

## Current Worker V2 contract

The Worker exposes only:

- `whoami` — authenticated profile alias.
- `get_service_ticket(ticketId)` — fixed `GET /service/tickets/{ticketId}` with a positive integer ID, returning only `{ id, status }`.

Ticket summary/description text, notes, attachments, attachment metadata, attachment URLs, and downloads are not part of the V2 contract.

## Active legacy tool decisions

| Legacy tool(s)                                                                                                                     | Decision                                 | Reason and V2 requirement                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search_api_endpoints`, `get_api_endpoint_details`, `natural_language_api_search`, `list_api_categories`, `get_category_endpoints` | **Legacy rollback only**                 | Generic API discovery reveals reusable endpoint information and is not a business operation. Do not create a V2 API catalog.                                                                                                                                                               |
| `execute_api_call`, `send_raw_api_request`                                                                                         | **Explicitly excluded**                  | Caller-controlled path, method, conditions, and body permit generic reads and writes. V2 will expose only fixed, purpose-built tools.                                                                                                                                                      |
| `save_to_fast_memory`, `list_fast_memory`, `delete_from_fast_memory`, `clear_fast_memory`                                          | **Explicitly excluded**                  | Persists or reveals arbitrary request templates, conditions, and payloads; includes destructive operations.                                                                                                                                                                                |
| `debug_notes_endpoint`, `try_notes_with_conditions`, `check_api_user_permissions`, `test_notes_crud_operations`                    | **Explicitly excluded**                  | Diagnostics, permission enumeration, conditions probing, and CRUD test behavior must never become MCP production tools.                                                                                                                                                                    |
| `get_ticket_notes_with_content`                                                                                                    | **Deferred; not a current V2 candidate** | Defaults expose internal notes and raw user-authored text without pagination/text bounds. A future proposal needs an explicit content/visibility/PII policy, privileged internal-note authorization, fixed page/cursor semantics, count and byte caps, and an allowlisted response schema. |
| `get_ticket_attachments_with_details`                                                                                              | **Deferred; not a current V2 candidate** | Names, descriptions, GUIDs, metadata, and URLs can disclose sensitive information. No metadata, URL, or binary download is exposed until a separate approved schema, entitlement, privacy, and audit design exists.                                                                        |
| `get_complete_ticket_content`                                                                                                      | **Legacy rollback only**                 | Aggregates ticket/contact data, notes, attachments, time entries, tasks, and task notes. Do not recreate an aggregate endpoint; future narrowly approved reads must be composed independently.                                                                                             |
| `download_ticket_attachment`                                                                                                       | **Explicitly excluded**                  | Attachment payload retrieval and caller filesystem paths are prohibited. A future download workflow would require separate authorization, content-size/type limits, scanning, and audit policy.                                                                                            |
| `create_ticket_note`                                                                                                               | **Explicitly excluded**                  | Customer-visible/internal text write. Any future write requires a separately approved authorization, visibility, idempotency, and immutable audit design.                                                                                                                                  |
| `search_tickets_by_content`                                                                                                        | **Deferred; not a current V2 candidate** | Interpolates caller text into ConnectWise conditions and has unbounded/broad result behavior. A future summary search needs a fixed grammar, server-side escaping/binding, page/cursor limits, board/tenant authorization, and scalar output only.                                         |
| `get_agreement_additions`, `get_agreement_additions_summary`, `get_agreement_billing_summary`                                      | **Deferred; finance-policy dependent**   | Commercial prices, cost, margin, billing, and invoice data require a finance entitlement, direct bounded aggregates, field allowlists, and no raw fallback objects.                                                                                                                        |
| `create_agreement_addition`                                                                                                        | **Explicitly excluded**                  | Financial write with product, quantity, price, and billing impact.                                                                                                                                                                                                                         |
| `search_agreement_additions`                                                                                                       | **Legacy rollback only**                 | Broad cross-agreement enumeration; filters are incomplete and results are not safely bounded.                                                                                                                                                                                              |

## Allowed future order of consideration

No additional V2 tool is authorized by this matrix. If a demonstrated requirement is approved later, evaluate in this order:

1. Ticket-summary search with a fixed grammar and scalar results only.
2. Finance-authorized agreement aggregate summary with direct server-side aggregation.
3. Detailed agreement additions only with finance entitlement, cursor paging, hard caps, and a strict commercial field allowlist.
4. Ticket notes or attachment metadata only after a dedicated raw-content/privacy policy is approved.

Every proposed tool needs a separate PR with fixed endpoint/schema review, tests proving zero secret/profile access before `mcp:read`, output/audit redaction tests, hostile-input tests, and staging acceptance evidence.

## Legacy rollback boundary

The Docker/FastAPI implementation remains a temporary rollback path, not a V2 compatibility target. Its controls and residual limitations are documented in the root README. This matrix does not authorize its broad tool surface for production use or V2 migration.
