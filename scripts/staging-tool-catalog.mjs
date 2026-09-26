import { createHash } from "node:crypto";

export const EXPECTED_TOOL_SCHEMA_HASHES = Object.freeze({
  whoami: "93ab7499dc3c616f8db8780fed0d9f69270803cda913882ad2ef3943db8d7225",
  get_service_ticket:
    "967a2bb6596563d77868da46b58175eb960c1ca94cad9b1a842b55464b8224c7",
  open_attachment_uploader:
    "3825199108823312a471dc0526927ce88bd4c7d1a4944ddb6c4d5e6e929cc5e3",
  upload_connectwise_image:
    "9eb19e791cbb14b0d694934c576a5fba44b27d45fb85177dbcb734d5bcd6f8cb",
  search_tickets_by_content:
    "93091be5a773f8b00cf7384643d5707d20c2da66efd861353bf1b4efc8d3fcbf",
  get_ticket_notes_with_content:
    "bd4860b1bba092191983eb40420fdb65550f22ee13b3a014c575807469d270bd",
  get_ticket_attachments_with_details:
    "17bbce167c9bf830eaa826f9ffd9f7c562f5398402270ca124f9fbb23e91e4f7",
  list_ticket_tasks:
    "17bbce167c9bf830eaa826f9ffd9f7c562f5398402270ca124f9fbb23e91e4f7",
  list_ticket_time_entries:
    "17bbce167c9bf830eaa826f9ffd9f7c562f5398402270ca124f9fbb23e91e4f7",
  get_complete_ticket_content:
    "81775f5a354403c26bd89c1f0a1b8d181f61b5561905d920180b99e27c751f2e",
  create_ticket_note:
    "c09f25e4771e12764885dea1a2d97e1ceb3916f696ce40ed5f73e8c912f910be",
  attach_image_to_ticket:
    "d877bcf0e8a73b3a1707b41f27049485eb4a597d02b92b3c25bb6aa5319e9443",
  attach_image_to_time_entry:
    "e41d4d4f09520aefe541d6eccc96f10a92edec3fb4f0038fe71e6a12d573daa1",
  get_agreement_additions:
    "f29f8170b1a7c148158105beccd563166ab38ae4f9cb886367a3004268dc3bf7",
  get_agreement_additions_summary:
    "f29f8170b1a7c148158105beccd563166ab38ae4f9cb886367a3004268dc3bf7",
  create_agreement_addition:
    "2300e860e85aed8a3930eabd91c2e52896233b697a2aace9f088b4e45f79fb8e",
  search_agreement_additions:
    "c7cc0e2e05ddfe41ebbd679fae736fa3fd2477931481e7331d5fd35e960d45bf",
  get_agreement_billing_summary:
    "c2b17768e4fd4303a589b74c5e7c09f5b70730a48a72b31ac69d6b1a0dd61d84",
  get_service_boards:
    "93ab7499dc3c616f8db8780fed0d9f69270803cda913882ad2ef3943db8d7225",
  get_board_options:
    "b9b509d8d9a6fb602bd80f63481f52674b28c78714b9a7efc07656958539509b",
  list_board_tickets:
    "3a774aefa708e1ba60a47572bb03141a785370612345e77e67468d632e269902",
  get_service_statuses:
    "93ab7499dc3c616f8db8780fed0d9f69270803cda913882ad2ef3943db8d7225",
  get_service_priorities:
    "93ab7499dc3c616f8db8780fed0d9f69270803cda913882ad2ef3943db8d7225",
  get_service_sources:
    "93ab7499dc3c616f8db8780fed0d9f69270803cda913882ad2ef3943db8d7225",
  get_my_member:
    "93ab7499dc3c616f8db8780fed0d9f69270803cda913882ad2ef3943db8d7225",
  search_members:
    "15171b145237ea80b813c18694b4143df2574a8d322f446d56ccef94d3e585ee",
  search_companies:
    "15171b145237ea80b813c18694b4143df2574a8d322f446d56ccef94d3e585ee",
  search_contacts:
    "15171b145237ea80b813c18694b4143df2574a8d322f446d56ccef94d3e585ee",
  list_time_entries:
    "d092755cbe07b7355c5abb5569e8dd15c1d4a0b4be02c1d26b15c4026996b853",
  list_schedule_entries:
    "d092755cbe07b7355c5abb5569e8dd15c1d4a0b4be02c1d26b15c4026996b853",
  get_time_sheets:
    "d092755cbe07b7355c5abb5569e8dd15c1d4a0b4be02c1d26b15c4026996b853",
  download_ticket_attachment:
    "1f9fbb5ae048a534b0f1ae21814df160a00f97d1e1b6b9ce6ed1238f6638edd6",
  call_connectwise:
    "a654164d163313f496de41e326660e5923981e73178419f363ac91d93cd2e48e",
  create_service_ticket:
    "65753c79701ae624f3a6f66736b2e4a60f237ed4b18caf23c89dc592349e1089",
  update_service_ticket:
    "9e3be678d90c8b9b8f7d899ff600c7e0899e675b0976b92c4a0f7013a35c5a65",
  create_schedule_entry:
    "40edb501d81a87eb27b27f8408f9dc83f78c0e9e4dd5edda23b0e012142b0b8d",
  update_schedule_entry:
    "51978daf293532fd6aa55c8de829dc82fe6bcfa3604d51d7c80d44ac55d01b83",
  delete_schedule_entry:
    "c9ae58624f4e9f329da7c4f514760b4020d8ea67556320063246d7a4b07cfb29",
  create_time_entry:
    "7e2d98fd9560ee0f43e377dcc5f06490f9066fdfb5236676507464a64842b7c6",
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
