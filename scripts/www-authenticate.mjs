const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const challengePattern = new RegExp(`^(${token})(?:[ \\t]+(.+))?$`);
const parameterPattern = new RegExp(
  `^(${token})[ \\t]*=[ \\t]*(?:"((?:\\\\.|[^"\\\\])*)"|(${token}))$`,
);
const token68Pattern = /^[A-Za-z0-9\-._~+/]+=*$/;

function splitOutsideQuotes(header) {
  const parts = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ",") {
      parts.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || escaped) return null;
  parts.push(header.slice(start).trim());
  return parts.every((part) => part.length > 0) ? parts : null;
}

export function bearerResourceMetadata(header) {
  if (typeof header !== "string") return null;
  const parts = splitOutsideQuotes(header);
  if (parts === null) return null;

  const challenges = [];
  let current = null;
  for (const part of parts) {
    if (parameterPattern.test(part)) {
      if (current === null || current.parameters.length === 0) return null;
      current.parameters.push(part);
      continue;
    }
    const challenge = part.match(challengePattern);
    if (challenge === null) return null;
    current = { scheme: challenge[1], parameters: [] };
    challenges.push(current);
    if (challenge[2] !== undefined) current.parameters.push(challenge[2]);
  }

  const metadataValues = [];
  for (const challenge of challenges) {
    if (challenge.parameters.length === 0) continue;
    const firstParameter = challenge.parameters[0].match(parameterPattern);
    if (firstParameter === null) {
      if (
        challenge.parameters.length !== 1 ||
        !token68Pattern.test(challenge.parameters[0])
      ) {
        return null;
      }
      continue;
    }

    const parameterNames = new Set();
    for (const parameter of challenge.parameters) {
      const parsed = parameter.match(parameterPattern);
      if (parsed === null) return null;
      const name = parsed[1].toLowerCase();
      if (parameterNames.has(name)) return null;
      parameterNames.add(name);
      if (
        challenge.scheme.toLowerCase() === "bearer" &&
        name === "resource_metadata"
      ) {
        if (parsed[2] === undefined) return null;
        metadataValues.push(parsed[2].replace(/\\(.)/g, "$1"));
      }
    }
  }
  return metadataValues.length === 1 ? metadataValues[0] : null;
}
