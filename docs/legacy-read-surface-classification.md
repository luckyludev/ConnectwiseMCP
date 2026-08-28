# Legacy MCP surface migration classification

> **Status:** decision record for Worker V2. The authenticated user's mapped ConnectWise API member is the final authority for both reads and writes. The active legacy implementation is `deploy/cwm-mcp/api_gateway/server.py`; archival copies are not part of this inventory.

## Authorization and safety rules

Entra authorization determines who may reach the MCP server and selects exactly one server-side `CW_PROFILE_<ALIAS>` secret. The `mcp:read` OAuth scope is the MCP server-access scope retained for compatibility with connected clients; it does not grant a ConnectWise permission. Every business call uses the mapped user's ConnectWise credentials, and ConnectWise Security Roles decide which boards, companies, finance records, projects, reads, and writes succeed.

V2 never accepts caller-selected ConnectWise hosts, endpoints, methods, credential headers, profile aliases, raw conditions, or arbitrary request bodies. Every tool uses a fixed route and method, validated inputs, server-controlled result bounds, an allowlisted output projection, sanitized failures, and an argument-free audit event. Non-idempotent writes are never retried after an ambiguous network failure.

## Current Worker V2 contract

The Worker exposes these bounded business tools:

- Identity and ticket metadata: `whoami`, `get_service_ticket`.
- Ticket reads: `search_tickets_by_content`, `get_ticket_notes_with_content`, `get_ticket_attachments_with_details`, `get_complete_ticket_content`.
- Ticket writes: `create_ticket_note`.
- Agreement reads: `get_agreement_additions`, `get_agreement_additions_summary`, `search_agreement_additions`, `get_agreement_billing_summary`.
- Agreement writes: `create_agreement_addition`.

Ticket-note text and commercial fields are returned only when the mapped ConnectWise API member can retrieve them. All list sections are capped at 50 items. Attachment tools return metadata only; they do not return download URLs, GUIDs, or binary content. The two write tools expose non-idempotent MCP annotations and return a small allowlisted receipt without echoing note text or arbitrary upstream fields.

## Active legacy tool decisions

| Legacy tool(s)                                                                                                                     | V2 decision              | Reason or replacement                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `search_api_endpoints`, `get_api_endpoint_details`, `natural_language_api_search`, `list_api_categories`, `get_category_endpoints` | **Excluded**             | Generic API discovery is not a business operation.                                                                          |
| `execute_api_call`, `send_raw_api_request`                                                                                         | **Excluded**             | Caller-controlled routes, methods, conditions, and bodies would bypass the purpose-built tool boundary.                     |
| `save_to_fast_memory`, `list_fast_memory`, `delete_from_fast_memory`, `clear_fast_memory`                                          | **Excluded**             | Arbitrary request-template persistence is unnecessary in the stateless Worker.                                              |
| `debug_notes_endpoint`, `try_notes_with_conditions`, `check_api_user_permissions`, `test_notes_crud_operations`                    | **Excluded**             | Diagnostics and permission probing are operational functions, not production MCP tools.                                     |
| `get_ticket_notes_with_content`                                                                                                    | **Migrated with bounds** | Fixed note endpoints, 50-item cap, 8,000-character per-note cap, visibility filtering, and allowlisted output.              |
| `get_ticket_attachments_with_details`                                                                                              | **Migrated as metadata** | Fixed document lookup with a 50-item cap; no URL, GUID, download instruction, or binary content is exposed.                 |
| `get_complete_ticket_content`                                                                                                      | **Migrated with bounds** | Composes fixed ticket, note, attachment-metadata, task, and time-entry reads with independent per-section caps.             |
| `download_ticket_attachment`                                                                                                       | **Excluded**             | Binary transfer requires separate size/type/scanning and client-delivery design.                                            |
| `create_ticket_note`                                                                                                               | **Migrated**             | Fixed payload, 8,000-character cap, explicit visibility flags, no automatic write retry, and an allowlisted receipt.        |
| `search_tickets_by_content`                                                                                                        | **Migrated with bounds** | Summary-only fixed grammar, single-quote escaping, recent-first ordering, and a 50-result cap.                              |
| `get_agreement_additions`, `get_agreement_additions_summary`, `get_agreement_billing_summary`                                      | **Migrated with bounds** | Fixed finance routes, strict commercial-field projections, a 50-addition cap, and a five-invoice cap.                       |
| `create_agreement_addition`                                                                                                        | **Migrated**             | Fixed route/payload, numeric/date bounds, enumerated billing option, no automatic write retry, and an allowlisted receipt.  |
| `search_agreement_additions`                                                                                                       | **Migrated narrowly**    | Search is restricted to one agreement and a bounded set; optional product/date filters run over the allowlisted projection. |

## Remaining boundary

The V2 catalog intentionally does not reproduce generic API execution, endpoint discovery, diagnostics, permission enumeration, arbitrary persistence, or attachment downloads. Adding a new business operation requires another fixed-route tool with bounded input/output schemas, no credential/profile selection, sanitized audit coverage, hostile-input tests, and staging evidence.

## Legacy rollback boundary

The Docker/FastAPI implementation remains a temporary rollback path, not a V2 compatibility target. Its broad generic tools must not be copied into the Worker. Remove the rollback deployment only after production cutover acceptance.
