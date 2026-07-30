export type ConsentPageOptions = {
  clientName: string;
  scopes: string[];
  signedState: string;
  csrfToken: string;
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

export function renderConsentPage(options: ConsentPageOptions): Response {
  const clientName = escapeHtml(options.clientName);
  const scopes = options.scopes
    .map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`)
    .join("");
  const signedState = escapeHtml(options.signedState);
  const csrfToken = escapeHtml(options.csrfToken);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ConnectWise MCP</title>
<style>body{font:16px system-ui;background:#0b1020;color:#e8edf7;margin:0}main{max-width:640px;margin:8vh auto;padding:32px;background:#151c31;border:1px solid #2a3659;border-radius:16px}h1{margin-top:0}code{color:#7dd3fc}button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-weight:700}small{color:#aab4cc}</style></head>
<body><main><h1>Authorize ConnectWise MCP</h1><p><strong>${clientName}</strong> is requesting access.</p><p>Requested scopes:</p><ul>${scopes}</ul>
<p><small>You will authenticate with Microsoft Entra. ConnectWise permissions remain limited by your mapped API member.</small></p>
<form method="post" action="/authorize"><input type="hidden" name="flow_state" value="${signedState}"><input type="hidden" name="csrf_token" value="${csrfToken}"><button type="submit">Continue with Microsoft</button></form></main></body></html>`;

  return new Response(html, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}
