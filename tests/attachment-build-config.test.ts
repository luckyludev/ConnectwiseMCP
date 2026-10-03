import { describe, expect, it } from "vitest";

import { inlineAttachmentAssets } from "../vite.attachment.config";

function runInlinePlugin(bundle: Record<string, unknown>): void {
  const hook = inlineAttachmentAssets().generateBundle;
  if (typeof hook !== "function") {
    throw new Error("Expected a generateBundle hook");
  }
  hook.call({} as never, {} as never, bundle as never, false);
}

describe("attachment asset inliner", () => {
  it("inlines the only JavaScript and stylesheet and escapes closing tags", () => {
    const bundle = {
      "index.html": {
        type: "asset",
        fileName: "index.html",
        source:
          '<link rel="stylesheet" crossorigin href="/assets/app.css"><script type="module" crossorigin src="/assets/app.js"></script>',
      },
      "assets/app.js": {
        type: "chunk",
        fileName: "assets/app.js",
        code: 'const closing = "</script>";',
      },
      "assets/app.css": {
        type: "asset",
        fileName: "assets/app.css",
        source: 'body::after{content:"</style>"}',
      },
    };

    runInlinePlugin(bundle);

    expect(Object.keys(bundle)).toEqual(["index.html"]);
    expect(bundle["index.html"].source).toBe(
      '<style>body::after{content:"<\\/style>"}</style><script type="module">const closing = "<\\/script>";</script>',
    );
  });

  it("fails closed on missing references and unexpected emitted assets", () => {
    expect(() =>
      runInlinePlugin({
        "index.html": {
          type: "asset",
          fileName: "index.html",
          source: "<html></html>",
        },
        "assets/app.js": {
          type: "chunk",
          fileName: "assets/app.js",
          code: "export {};",
        },
      }),
    ).toThrow("Attachment HTML contains an unexpected external script");

    expect(() =>
      runInlinePlugin({
        "index.html": {
          type: "asset",
          fileName: "index.html",
          source: "<html></html>",
        },
        "assets/image.png": {
          type: "asset",
          fileName: "assets/image.png",
          source: new Uint8Array([1]),
        },
      }),
    ).toThrow("Attachment build emitted unexpected asset assets/image.png");
  });

  it("rejects every remaining external script and stylesheet reference", () => {
    for (const reference of [
      "/assets/app.js",
      "./app.js",
      "/app.js",
      "//cdn.example/app.js",
      "https://cdn.example/app.js",
    ]) {
      expect(() =>
        runInlinePlugin({
          "index.html": {
            type: "asset",
            fileName: "index.html",
            source: `<script type="module" src="${reference}"></script>`,
          },
        }),
      ).toThrow("Attachment HTML contains an unexpected external script");
    }

    for (const reference of [
      "/assets/app.css",
      "./app.css",
      "/app.css",
      "//cdn.example/app.css",
      "https://cdn.example/app.css",
    ]) {
      expect(() =>
        runInlinePlugin({
          "index.html": {
            type: "asset",
            fileName: "index.html",
            source: `<link href="${reference}" rel="stylesheet">`,
          },
        }),
      ).toThrow("Attachment HTML contains an unexpected external stylesheet");
    }

    expect(() =>
      runInlinePlugin({
        "index.html": {
          type: "asset",
          fileName: "index.html",
          source:
            '<script data-note=">" src="https://cdn.example/app.js"></script>',
        },
      }),
    ).toThrow("Attachment HTML contains an unexpected external script");
    expect(() =>
      runInlinePlugin({
        "index.html": {
          type: "asset",
          fileName: "index.html",
          source:
            '<link data-note=">" rel="stylesheet" href="https://cdn.example/app.css">',
        },
      }),
    ).toThrow("Attachment HTML contains an unexpected external stylesheet");

    expect(() =>
      runInlinePlugin({
        "index.html": {
          type: "asset",
          fileName: "index.html",
          source:
            '<script data-note=\'<script type="module" crossorigin src="/assets/app.js"></script>\' src="https://evil.example/x.js"></script>',
        },
        "assets/app.js": {
          type: "chunk",
          fileName: "assets/app.js",
          code: "export {};",
        },
      }),
    ).toThrow("Attachment HTML contains an unexpected external script");

    for (const source of [
      '<script / src="https://evil.example/x.js"></script>',
      '<link / rel="stylesheet" href="https://evil.example/x.css">',
    ]) {
      expect(() =>
        runInlinePlugin({
          "index.html": {
            type: "asset",
            fileName: "index.html",
            source,
          },
        }),
      ).toThrow("Attachment HTML is malformed");
    }

    expect(() =>
      runInlinePlugin({
        "index.html": {
          type: "asset",
          fileName: "index.html",
          source:
            '<script type="module" crossorigin src="/assets/app.js"></script><script foo"></script><script src=https://evil.example/x.js x"></script>',
        },
        "assets/app.js": {
          type: "chunk",
          fileName: "assets/app.js",
          code: "export {};",
        },
      }),
    ).toThrow("Attachment HTML is malformed");

    expect(() =>
      runInlinePlugin({
        "index.html": {
          type: "asset",
          fileName: "index.html",
          source:
            '<script type="module" crossorigin src="/assets/app.js"></script><script type="module" src="/assets/app.js"></script>',
        },
        "assets/app.js": {
          type: "chunk",
          fileName: "assets/app.js",
          code: "export {};",
        },
      }),
    ).toThrow("Attachment HTML contains an unexpected external script");
  });

  it("rejects unsupported active URL and stylesheet constructs", () => {
    expect(() =>
      runInlinePlugin({
        "index.html": {
          type: "asset",
          fileName: "index.html",
          source:
            '<svg><script href="https://evil.example/x.js"></script></svg>',
        },
      }),
    ).toThrow("Attachment HTML contains an unexpected URL attribute");
    expect(() =>
      runInlinePlugin({
        "index.html": {
          type: "asset",
          fileName: "index.html",
          source: '<style>@import "https://evil.example/x.css";</style>',
        },
      }),
    ).toThrow("Attachment HTML contains an unexpected style element");
  });

  it("requires exactly one textual HTML output", () => {
    expect(() => runInlinePlugin({})).toThrow(
      "Attachment build must emit exactly one HTML file",
    );
    expect(() =>
      runInlinePlugin({
        "index.html": {
          type: "asset",
          fileName: "index.html",
          source: new Uint8Array([1]),
        },
      }),
    ).toThrow("Attachment HTML output must be text");
  });
});
