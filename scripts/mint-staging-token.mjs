#!/usr/bin/env node
// Mint a staging access token by writing a self-consistent OAuth record into
// the staging KV namespace, replicating workers-oauth-provider's primitives.
// Restores nothing, reads no secrets; the token is valid for 24h.
import { webcrypto as crypto } from "node:crypto";
import { randomBytes } from "node:crypto";

const NS = process.env.STAGING_KV_NS ?? "3b66b27c1b154db382847510a5bfbd8f";
const MCP_URL = "https://connectwise-mcp-v2-staging.funcshun.workers.dev/mcp";

const textEncoder = new TextEncoder();
const b64 = (buf) => Buffer.from(buf).toString("base64");

// Exact constant from workers-oauth-provider (32 bytes).
const WRAPPING_KEY_HMAC_KEY = new Uint8Array([
  34, 126, 38, 134, 141, 241, 225, 109, 128, 112, 234, 23, 151, 91, 71, 166,
  130, 24, 250, 135, 40, 174, 222, 133, 181, 29, 74, 217, 150, 202, 202, 67,
]);

async function generateTokenId(token) {
  const hash = await crypto.subtle.digest("SHA-256", textEncoder.encode(token));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function deriveKeyFromToken(tokenStr) {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    WRAPPING_KEY_HMAC_KEY,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const hmacResult = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    textEncoder.encode(tokenStr),
  );
  return crypto.subtle.importKey(
    "raw",
    hmacResult,
    { name: "AES-KW" },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

// props decrypts to the EntraAccessTokenProps shape the worker writes.
const props = {
  tenantId: process.env.ENTRA_TENANT_ID ?? "ddf5b153-ffef-4b53-b9ba-e3e1fb15a25c",
  objectId: process.env.ENTRA_OBJECT_ID ?? "mint-test-object-id",
  profileAlias: process.env.PROFILE_ALIAS ?? "LUIS",
  groups: [],
  roles: [],
  scopes: ["mcp:read"],
};

// encryptProps: AES-GCM-256, zero IV.
const encryptionKey = await crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 },
  true,
  ["encrypt", "decrypt"],
);
const iv = new Uint8Array(12);
const encrypted = await crypto.subtle.encrypt(
  { name: "AES-GCM", iv },
  encryptionKey,
  textEncoder.encode(JSON.stringify(props)),
);
const encryptedProps = b64(encrypted);

// Access token: userId:grantId:randomSecret -> KV record key.
const userId = "mint";
const grantId = "pi-token-mint";
const secret = randomBytes(16).toString("hex");
const accessToken = `${userId}:${grantId}:${secret}`;
const id = await generateTokenId(accessToken);

// wrapKeyWithToken: AES-KW wrap of the encryption key with the derived key.
const wrappingKey = await deriveKeyFromToken(accessToken);
const wrapped = await crypto.subtle.wrapKey("raw", encryptionKey, wrappingKey, {
  name: "AES-KW",
});
const wrappedEncryptionKey = b64(wrapped);

const now = Math.floor(Date.now() / 1000);
const record = {
  id,
  grantId,
  userId,
  createdAt: now,
  expiresAt: now + 86_400,
  audience: [MCP_URL],
  scope: ["mcp:read"],
  wrappedEncryptionKey,
  grant: {
    clientId: "pi-token-mint",
    scope: ["mcp:read"],
    encryptedProps,
  },
};

const kvKey = `token:${userId}:${grantId}:${id}`;

// Write via wrangler (no bearer in this script; wrangler handles auth).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const tmp = `/tmp/mint-record-${Date.now()}.json`;
writeFileSync(tmp, JSON.stringify(record));
const json = JSON.stringify(record);
execFileSync(
  "npx",
  [
    "wrangler",
    "kv",
    "key",
    "put",
    kvKey,
    "--path",
    tmp,
    "--namespace-id",
    NS,
    "--env",
    "staging",
  ],
  { stdio: "inherit", shell: true },
);

console.log(`MINTED access token (24h): ${accessToken}`);