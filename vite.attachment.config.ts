import {
  parseFragment,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from "parse5";
import { defineConfig, type Plugin } from "vite";

const pathFromUrl = (value: URL) => decodeURIComponent(value.pathname);
const root = pathFromUrl(new URL("./ui/attachment-uploader", import.meta.url));
const outDir = pathFromUrl(new URL("./.attachment-app-dist", import.meta.url));

function escapeClosingTag(source: string, tag: "script" | "style"): string {
  return source.replace(new RegExp(`</${tag}`, "giu"), `<\\/${tag}`);
}

function bundlePublicPath(fileName: string): string {
  return `/${fileName
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function htmlElements(
  html: string,
  tagName: string | null,
): DefaultTreeAdapterTypes.Element[] {
  const parseErrors: ParserError[] = [];
  const document = parseFragment(html, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parseErrors.push(error),
  });
  if (parseErrors.length > 0) {
    throw new Error("Attachment HTML is malformed");
  }

  const elements: DefaultTreeAdapterTypes.Element[] = [];
  function visit(node: DefaultTreeAdapterTypes.Node): void {
    if ("tagName" in node && (tagName === null || node.tagName === tagName)) {
      elements.push(node);
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child);
    }
    if ("content" in node) visit(node.content);
  }
  visit(document);
  return elements;
}

function htmlAttribute(
  element: DefaultTreeAdapterTypes.Element,
  name: string,
): string | null {
  return (
    element.attrs.find((attribute) => attribute.name === name)?.value ?? null
  );
}

function elementStartTag(
  html: string,
  element: DefaultTreeAdapterTypes.Element,
): string {
  const location = element.sourceCodeLocation?.startTag;
  if (!location)
    throw new Error("Attachment HTML element has no source location");
  return html.slice(location.startOffset, location.endOffset);
}

function sameStringSet(actual: string[], expected: string[]): boolean {
  const expectedSorted = expected.toSorted();
  return (
    actual.length === expected.length &&
    actual.toSorted().every((value, index) => value === expectedSorted[index])
  );
}

export function inlineAttachmentAssets(): Plugin {
  return {
    name: "inline-attachment-assets",
    enforce: "post",
    generateBundle(_options, bundle) {
      const htmlEntries = Object.values(bundle).filter(
        (entry) => entry.type === "asset" && entry.fileName.endsWith(".html"),
      );
      if (htmlEntries.length !== 1) {
        throw new Error("Attachment build must emit exactly one HTML file");
      }

      const htmlEntry = htmlEntries[0]!;
      if (htmlEntry.type !== "asset" || typeof htmlEntry.source !== "string") {
        throw new Error("Attachment HTML output must be text");
      }
      let html = htmlEntry.source;

      const urlAttributes = new Set([
        "action",
        "background",
        "data",
        "formaction",
        "href",
        "poster",
        "src",
        "srcset",
      ]);
      for (const element of htmlElements(html, null)) {
        if (element.tagName === "style") {
          throw new Error(
            "Attachment HTML contains an unexpected style element",
          );
        }
        const rel = (htmlAttribute(element, "rel") ?? "")
          .toLowerCase()
          .split(/\s+/u);
        for (const attribute of element.attrs) {
          if (attribute.name === "style") {
            throw new Error(
              "Attachment HTML contains an unexpected style attribute",
            );
          }
          if (!urlAttributes.has(attribute.name)) continue;
          const allowedScript =
            element.tagName === "script" &&
            attribute.name === "src" &&
            !attribute.prefix;
          const allowedStylesheet =
            element.tagName === "link" &&
            attribute.name === "href" &&
            !attribute.prefix &&
            rel.includes("stylesheet");
          if (!allowedScript && !allowedStylesheet) {
            throw new Error(
              "Attachment HTML contains an unexpected URL attribute",
            );
          }
        }
      }

      const emittedScripts = Object.entries(bundle)
        .filter(
          ([, entry]) =>
            entry.type === "chunk" && entry.fileName.endsWith(".js"),
        )
        .map(([fileName]) => bundlePublicPath(fileName));
      const referencedScripts = htmlElements(html, "script")
        .map((element) => htmlAttribute(element, "src"))
        .filter((value): value is string => value !== null);
      if (!sameStringSet(referencedScripts, emittedScripts)) {
        throw new Error(
          "Attachment HTML contains an unexpected external script",
        );
      }

      const emittedStylesheets = Object.entries(bundle)
        .filter(
          ([, entry]) =>
            entry.type === "asset" && entry.fileName.endsWith(".css"),
        )
        .map(([fileName]) => bundlePublicPath(fileName));
      const referencedStylesheets = htmlElements(html, "link")
        .filter((element) =>
          (htmlAttribute(element, "rel") ?? "")
            .toLowerCase()
            .split(/\s+/u)
            .includes("stylesheet"),
        )
        .map((element) => htmlAttribute(element, "href"))
        .filter((value): value is string => value !== null);
      if (!sameStringSet(referencedStylesheets, emittedStylesheets)) {
        throw new Error(
          "Attachment HTML contains an unexpected external stylesheet",
        );
      }

      for (const [fileName, entry] of Object.entries(bundle)) {
        if (entry === htmlEntry) continue;
        const publicPath = bundlePublicPath(fileName);

        if (entry.type === "chunk" && fileName.endsWith(".js")) {
          const expectedTag = `<script type="module" crossorigin src="${publicPath}">`;
          const elements = htmlElements(html, "script").filter(
            (element) => elementStartTag(html, element) === expectedTag,
          );
          const location = elements[0]?.sourceCodeLocation;
          if (
            elements.length !== 1 ||
            !location?.startTag ||
            !location.endTag
          ) {
            throw new Error(`Attachment HTML does not reference ${fileName}`);
          }
          html = `${html.slice(0, location.startTag.startOffset)}<script type="module">${escapeClosingTag(entry.code, "script")}</script>${html.slice(location.endTag.endOffset)}`;
          delete bundle[fileName];
          continue;
        }

        if (
          entry.type === "asset" &&
          fileName.endsWith(".css") &&
          typeof entry.source === "string"
        ) {
          const expectedTag = `<link rel="stylesheet" crossorigin href="${publicPath}">`;
          const elements = htmlElements(html, "link").filter(
            (element) => elementStartTag(html, element) === expectedTag,
          );
          const location = elements[0]?.sourceCodeLocation?.startTag;
          if (elements.length !== 1 || !location) {
            throw new Error(`Attachment HTML does not reference ${fileName}`);
          }
          html = `${html.slice(0, location.startOffset)}<style>${escapeClosingTag(entry.source, "style")}</style>${html.slice(location.endOffset)}`;
          delete bundle[fileName];
          continue;
        }

        throw new Error(
          `Attachment build emitted unexpected asset ${fileName}`,
        );
      }

      htmlEntry.source = html;
    },
  };
}

export default defineConfig({
  root,
  plugins: [inlineAttachmentAssets()],
  build: {
    outDir,
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    cssMinify: true,
    minify: true,
    rollupOptions: {
      input: pathFromUrl(
        new URL("./ui/attachment-uploader/index.html", import.meta.url),
      ),
      output: {
        codeSplitting: false,
      },
    },
  },
});
