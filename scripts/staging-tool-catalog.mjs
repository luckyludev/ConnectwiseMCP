import { createHash } from "node:crypto";

export const EXPECTED_TOOL_SCHEMA_HASHES = Object.freeze({
  whoami: "71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892",
  get_service_ticket:
    "fbfc17a176368912d8b30958f0fb6ccaacb1d71a861052c1de139f4ac597f999",
  open_attachment_uploader:
    "138d6be20887110e9f3b3b3e464c6f9b3d7e942a2205fb0d5e04c701b66de32f",
  upload_connectwise_image:
    "fa29b23ad3c2c495022d78ab750027a83070225462002796f3e58c0151dab209",
  search_tickets_by_content:
    "44b847c6caec8a25763229e78ee8a971e57f500e205f2da9c104c42c509aa072",
  get_ticket_notes_with_content:
    "c7a4bd82b37e793c4ff43bb3d1278cce53d012850d56669e9f60480392f20888",
  get_ticket_attachments_with_details:
    "c486a740727c4a4772f1de140907d6384bfec2a326ed4117e2945b909f5ebefa",
  list_ticket_tasks:
    "c486a740727c4a4772f1de140907d6384bfec2a326ed4117e2945b909f5ebefa",
  list_ticket_time_entries:
    "c486a740727c4a4772f1de140907d6384bfec2a326ed4117e2945b909f5ebefa",
  get_complete_ticket_content:
    "e261d160571333d00f9ef3c6c57f01b142f7456ecdc7190fedd724a527037809",
  create_ticket_note:
    "1358777b4bd5021debf5b445065c86547f39c310e0051463180d76e7fd388c43",
  attach_image_to_ticket:
    "59218ead9de8d554b00565628a033720f0643ea437b988eddcb44fec03d06599",
  attach_image_to_time_entry:
    "d62cb623fb69015c1eca7a2b6a4dce7e0a147ffbbdaeff27b1c1f557762adf91",
  get_agreement_additions:
    "b24c1a9038368f6845afc99a782e9a1bbadcfdbcad91f9170df65ad5ab1c61f1",
  get_agreement_additions_summary:
    "b24c1a9038368f6845afc99a782e9a1bbadcfdbcad91f9170df65ad5ab1c61f1",
  create_agreement_addition:
    "716295afeda93d88f342ec82dfa51a4e9e13518c3e32b20c9c92074005b26641",
  search_agreement_additions:
    "e4db99f9ccdd47181e97fda1c0c7f2e21bf7e28b3c0781626d8f5d9012f16cc5",
  get_agreement_billing_summary:
    "af42c2c66fe4e7abfd06e2c44fe34bdb2ed7d96786b4f32387b5d43b695372cf",
  get_service_boards:
    "71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892",
  get_board_options:
    "6c11b370141d1619b98cf82de9723c4dbd743b9cab24e7f335b63da4a3ea55b4",
  list_board_tickets:
    "0dcee0bdd6a32e4a9811e0b0c2aad7e59a0872658a8e235c4added9858dfa1db",
  get_service_statuses:
    "71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892",
  get_service_priorities:
    "71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892",
  get_service_sources:
    "71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892",
  get_my_member:
    "71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892",
  search_members:
    "a45163f0eb5dfceeb992ca539e86f96c6cd4c54a5c604b2f810646358ab253a0",
  search_companies:
    "a45163f0eb5dfceeb992ca539e86f96c6cd4c54a5c604b2f810646358ab253a0",
  search_contacts:
    "a45163f0eb5dfceeb992ca539e86f96c6cd4c54a5c604b2f810646358ab253a0",
  list_time_entries:
    "952575964e26ee5c6ee3bc06c69ba7449d92f64e1e5e1882442e23925c81ce96",
  list_schedule_entries:
    "952575964e26ee5c6ee3bc06c69ba7449d92f64e1e5e1882442e23925c81ce96",
  get_time_sheets:
    "952575964e26ee5c6ee3bc06c69ba7449d92f64e1e5e1882442e23925c81ce96",
  download_ticket_attachment:
    "bfa957cbe67666ba8257e49f9b742a6792c41d327f260fee220606191cf57dbc",
  call_connectwise:
    "ce53778f0fd3c7127be5abbd2ff8f4cc9fae044e7abc1970ef45fe54a7a7f18b",
  create_service_ticket:
    "5767fbe407089a9067ccc9aa2f504540f68d1d049e5ad833e432afef249a3f82",
  update_service_ticket:
    "d8244216ed2a169b41bf75ef1214081b26345e8ad06f2185925666c546ba28d8",
  create_schedule_entry:
    "43e74833ece7c1795119470bd6866efd3f35988e8bef43a52ab566f12de4595f",
  update_schedule_entry:
    "e649b32476f8fd95485fb802516f5e69931e935dfacb228e65a868550fb50d55",
  delete_schedule_entry:
    "cca10d4eeaa70734a42e8edc520bb0daf3b515f80145117ef510a072310fecce",
  create_time_entry:
    "8a6228dc953be722c7bd2190de0ad1dd0660b1d4545714f43e22af94d16e20b3",
});

export const EXPECTED_TOOL_NAMES = Object.freeze(
  Object.keys(EXPECTED_TOOL_SCHEMA_HASHES),
);

const WRITE_TOOL_NAMES = new Set([
  "upload_connectwise_image",
  "create_ticket_note",
  "attach_image_to_ticket",
  "attach_image_to_time_entry",
  "create_agreement_addition",
  "create_service_ticket",
  "update_service_ticket",
  "create_schedule_entry",
  "update_schedule_entry",
  "delete_schedule_entry",
  "create_time_entry",
]);
const DESTRUCTIVE_TOOL_NAMES = new Set([
  "create_agreement_addition",
  "update_service_ticket",
  "update_schedule_entry",
  "delete_schedule_entry",
]);
const APP_ONLY_TOOL_NAME = "upload_connectwise_image";

function expectedAnnotations(name) {
  const isWrite = WRITE_TOOL_NAMES.has(name);
  return {
    readOnlyHint: !isWrite,
    destructiveHint: DESTRUCTIVE_TOOL_NAMES.has(name),
    idempotentHint: !isWrite,
    openWorldHint: name !== "whoami",
  };
}

function validateAnnotations(tool) {
  const annotations = tool.annotations;
  const expected = expectedAnnotations(tool.name);
  if (
    annotations === null ||
    typeof annotations !== "object" ||
    Array.isArray(annotations) ||
    Object.entries(expected).some(([key, value]) => annotations[key] !== value)
  ) {
    return `tools/list annotations drifted for ${tool.name}`;
  }
  return undefined;
}

function visibility(tool) {
  return tool?._meta?.ui?.visibility;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateInputSchema(tool) {
  const schema = tool.inputSchema;
  const hasObjectProperties =
    schema !== null &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    schema.properties !== null &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties);
  const hasObjectVariants =
    schema !== null &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    Array.isArray(schema.oneOf) &&
    schema.oneOf.length > 0 &&
    schema.oneOf.every(
      (variant) =>
        variant !== null &&
        typeof variant === "object" &&
        !Array.isArray(variant) &&
        variant.type === "object" &&
        variant.additionalProperties === false &&
        variant.properties !== null &&
        typeof variant.properties === "object" &&
        !Array.isArray(variant.properties),
    );
  if (
    schema?.type !== "object" ||
    (!hasObjectProperties && !hasObjectVariants)
  ) {
    return `tools/list exposes an invalid input schema for ${tool.name}`;
  }

  const digest = createHash("sha256")
    .update(canonicalJson(schema))
    .digest("hex");
  if (digest !== EXPECTED_TOOL_SCHEMA_HASHES[tool.name]) {
    return `tools/list input schema drifted for ${tool.name}`;
  }
  return undefined;
}

export function validateStagingToolsListResult(result) {
  if (result === null || typeof result !== "object") {
    return "tools/list returned an invalid result";
  }
  if (result.nextCursor !== undefined) {
    return "tools/list pagination is not allowed for the fixed catalog";
  }
  return validateStagingToolCatalog(result.tools);
}

export function validateStagingToolCatalog(tools) {
  if (!Array.isArray(tools)) return "tools/list returned an invalid catalog";
  if (
    tools.some(
      (tool) =>
        tool === null ||
        typeof tool !== "object" ||
        typeof tool.name !== "string",
    )
  ) {
    return "tools/list contains malformed tool entries";
  }

  const names = tools.map((tool) => tool.name);
  if (names.length !== EXPECTED_TOOL_NAMES.length) {
    return `tools/list returned ${names.length} tools; expected ${EXPECTED_TOOL_NAMES.length}`;
  }
  if (new Set(names).size !== names.length) {
    return "tools/list contains duplicate tool names";
  }

  const expected = new Set(EXPECTED_TOOL_NAMES);
  const missingCount = EXPECTED_TOOL_NAMES.filter(
    (name) => !names.includes(name),
  ).length;
  if (missingCount > 0) {
    return `tools/list is missing ${missingCount} expected tool(s)`;
  }
  const unexpectedCount = names.filter((name) => !expected.has(name)).length;
  if (unexpectedCount > 0) {
    return `tools/list exposes ${unexpectedCount} unexpected tool(s)`;
  }

  for (const tool of tools) {
    const schemaError = validateInputSchema(tool);
    if (schemaError) return schemaError;
    const annotationError = validateAnnotations(tool);
    if (annotationError) return annotationError;

    const declaredVisibility = visibility(tool);
    if (tool.name === APP_ONLY_TOOL_NAME) {
      if (
        !Array.isArray(declaredVisibility) ||
        declaredVisibility.length !== 1 ||
        declaredVisibility[0] !== "app"
      ) {
        return "tools/list does not preserve the app-only upload boundary";
      }
      continue;
    }
    if (
      declaredVisibility !== undefined &&
      (!Array.isArray(declaredVisibility) ||
        !declaredVisibility.includes("model"))
    ) {
      return "tools/list hides an unexpected tool from model clients";
    }
  }

  return undefined;
}
