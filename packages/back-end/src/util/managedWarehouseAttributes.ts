import type { SDKAttribute, SDKAttributeType } from "shared/types/organization";
import type { MaterializedColumn } from "shared/types/datasource";
import type { FactTableColumnType } from "shared/types/fact-table";

export type ClickHouseDataType =
  | "DateTime"
  | "Float64"
  | "Boolean"
  | "String"
  | "LowCardinality(String)"
  | "Array(String)"
  | "Array(Float64)";

/**
 * Columns the Managed Warehouse always writes alongside user attributes.
 * Centralized here so `RESERVED_MANAGED_WAREHOUSE_COLUMN_NAMES` and the
 * back-end table DDL share a single source of truth.
 */
export const MANAGED_WAREHOUSE_REMAINING_COLUMNS: Record<
  string,
  ClickHouseDataType
> = {
  environment: "LowCardinality(String)",
  sdk_language: "LowCardinality(String)",
  sdk_version: "LowCardinality(String)",
  event_uuid: "String",
  ip: "String",
};

/**
 * Columns the ingestor writes to the top-level of the `events` table. These
 * are either server-enriched (geo_*, ua_*, url_{path,host,query,fragment}) or
 * SDK-sent top-level fields (device_id, utm_*, url, …) — none of them live
 * inside `context_json`, so they aren't visible to the SDK at feature /
 * experiment assignment time. We materialize them for dimension analysis but
 * they are NOT part of the org's attributeSchema.
 */
export const WAREHOUSE_BUILTIN_FIELD_TYPES: Record<string, ClickHouseDataType> =
  {
    user_id: "String",
    url: "String",
    url_path: "String",
    url_host: "String",
    url_query: "String",
    url_fragment: "String",
    device_id: "String",
    page_id: "String",
    session_id: "String",
    page_title: "String",
    utm_source: "String",
    utm_medium: "String",
    utm_campaign: "String",
    utm_term: "String",
    utm_content: "String",
    geo_country: "String",
    geo_city: "String",
    geo_lat: "Float64",
    geo_lon: "Float64",
    ua: "String",
    ua_browser: "String",
    ua_os: "String",
    ua_device_type: "String",
  };

function clickhouseTypeToFactTableType(
  type: ClickHouseDataType,
): FactTableColumnType {
  switch (type) {
    case "Float64":
      return "number";
    case "Boolean":
      return "boolean";
    case "DateTime":
      return "date";
    case "String":
    case "LowCardinality(String)":
    case "Array(String)":
    case "Array(Float64)":
      return "string";
  }
}

/**
 * Warehouse-owned materialized columns that we always maintain in ClickHouse,
 * independent of the organization's attributeSchema. These correspond to the
 * ingestor's enrichment + SDK top-level fields and are used for dimension
 * analysis; they are never exposed through `attributeSchema` because they
 * aren't available to the SDK at assignment time.
 */
export const WAREHOUSE_BUILTIN_COLUMNS: MaterializedColumn[] = Object.entries(
  WAREHOUSE_BUILTIN_FIELD_TYPES,
).map(([name, type]) => ({
  columnName: name,
  sourceField: name,
  datatype: clickhouseTypeToFactTableType(type),
  type: "dimension",
}));

export const WAREHOUSE_BUILTIN_COLUMN_NAMES: ReadonlySet<string> = new Set(
  WAREHOUSE_BUILTIN_COLUMNS.map((c) => c.columnName),
);

/**
 * Lowercased set of base-table column names that user attributes must not
 * collide with on a Managed Warehouse.
 */
export const RESERVED_MANAGED_WAREHOUSE_COLUMN_NAMES: ReadonlySet<string> =
  new Set(
    [
      "timestamp",
      "client_key",
      "event_name",
      "properties",
      "attributes",
      "experiment_id",
      "variation_id",
      ...Object.keys(MANAGED_WAREHOUSE_REMAINING_COLUMNS),
    ].map((col) => col.toLowerCase()),
  );

/**
 * Map an SDK attribute datatype to the MaterializedColumn representation the
 * ClickHouse service uses to generate DDL.
 */
export function materializedColumnTypeFromAttribute(
  datatype: SDKAttribute["datatype"],
): { datatype: FactTableColumnType; arrayElementType?: "string" | "number" } {
  switch (datatype) {
    case "string":
    case "secureString":
    case "enum":
      return { datatype: "string" };
    case "number":
      return { datatype: "number" };
    case "boolean":
      return { datatype: "boolean" };
    case "string[]":
    case "secureString[]":
      return { datatype: "string", arrayElementType: "string" };
    case "number[]":
      return { datatype: "number", arrayElementType: "number" };
  }
}

/**
 * Derive the list of ClickHouse materialized columns that correspond to the
 * organization's current attributeSchema. Archived attributes are excluded.
 *
 * Identifier semantics: attributes with `hashAttribute: true` are treated as
 * identifiers (they flow into `userIdTypes` and the auto-generated exposure
 * queries). Array-typed attributes are never identifiers because `hashAttribute`
 * is scalar-only in the UI and SDK.
 *
 * Attributes whose `property` isn't a valid Managed Warehouse column name
 * are skipped rather than materialized. `onInvalidAttribute` is invoked
 * for each skipped attribute so callers can log the skip. This is the
 * safety net that keeps system-added attributes like `$groups` from
 * blowing up sync with a raw ClickHouse DDL error.
 */
export function deriveMaterializedColumnsFromAttributes(
  attributes: SDKAttribute[],
  {
    onInvalidAttribute,
  }: {
    onInvalidAttribute?: (attribute: SDKAttribute, reason: string) => void;
  } = {},
): MaterializedColumn[] {
  const columns: MaterializedColumn[] = [];

  for (const attr of attributes) {
    if (attr.archived) continue;

    const matColType = materializedColumnTypeFromAttribute(attr.datatype);

    const invalidReason = validateManagedWarehouseColumnName(attr.property);
    if (invalidReason) {
      onInvalidAttribute?.(attr, invalidReason);
      continue;
    }

    const isArray = !!matColType.arrayElementType;
    const canBeIdentifier =
      !isArray && (attr.datatype === "string" || attr.datatype === "number");
    const isIdentifier = canBeIdentifier && attr.hashAttribute === true;

    columns.push({
      columnName: attr.property,
      sourceField: attr.property,
      datatype: matColType.datatype,
      type: isIdentifier ? "identifier" : "dimension",
      arrayElementType: matColType.arrayElementType,
    });
  }

  return columns;
}

/**
 * Two derived columns are considered equivalent (same ClickHouse type) when
 * their datatype and array-element type match. Column name / role ("identifier"
 * vs "dimension") are intentionally ignored here because those can change
 * without requiring DDL.
 */
export function materializedColumnTypeEquals(
  a: MaterializedColumn,
  b: MaterializedColumn,
): boolean {
  return (
    a.datatype === b.datatype &&
    (a.arrayElementType ?? undefined) === (b.arrayElementType ?? undefined)
  );
}

export type MaterializedColumnDiff = {
  columnsToAdd: MaterializedColumn[];
  columnsToDelete: string[];
  columnsToRename: { from: string; to: string }[];
  finalColumns: MaterializedColumn[];
  originalColumns: MaterializedColumn[];
};

/**
 * Given the before/after materialized-column lists and an optional list of
 * renames (old columnName -> new columnName), produce the add/delete/rename
 * plan that the ClickHouse service consumes. Throws when a column would need
 * to change datatype while keeping the same name — that scenario is not
 * supported in a single ALTER TABLE and must be handled by deleting the
 * attribute and creating a new one.
 */
export function computeMaterializedColumnDiff({
  originalColumns,
  finalColumns,
  renames = [],
}: {
  originalColumns: MaterializedColumn[];
  finalColumns: MaterializedColumn[];
  renames?: { from: string; to: string }[];
}): MaterializedColumnDiff {
  const originalByName = new Map(originalColumns.map((c) => [c.columnName, c]));
  const finalByName = new Map(finalColumns.map((c) => [c.columnName, c]));

  const appliedRenames: { from: string; to: string }[] = [];
  for (const { from, to } of renames) {
    if (from === to) continue;
    const prev = originalByName.get(from);
    const next = finalByName.get(to);
    if (!prev || !next) continue;
    if (!materializedColumnTypeEquals(prev, next)) {
      // Type also changed — treat as drop + add instead of rename so
      // ClickHouse creates the new column with the correct datatype.
      continue;
    }
    if (originalByName.has(to)) {
      // Destination name is already in use by a different existing column.
      // Shouldn't happen if upstream enforces attribute-property uniqueness,
      // but guard so we don't silently drop the existing column from the
      // diff and strand it in ClickHouse.
      throw new Error(
        `Cannot rename Managed Warehouse column "${from}" to "${to}" — a column named "${to}" already exists.`,
      );
    }
    originalByName.delete(from);
    originalByName.set(to, {
      ...prev,
      columnName: to,
      sourceField: to,
      type: next.type,
    });
    appliedRenames.push({ from, to });
  }

  const columnsToAdd: MaterializedColumn[] = [];
  for (const [name, col] of finalByName.entries()) {
    const prev = originalByName.get(name);
    if (!prev) {
      columnsToAdd.push(col);
      continue;
    }
    if (!materializedColumnTypeEquals(prev, col)) {
      throw new Error(
        `Cannot change the datatype of attribute "${name}" on a Managed Warehouse. Delete the attribute and create it again instead.`,
      );
    }
  }

  const columnsToDelete: string[] = [];
  for (const name of originalByName.keys()) {
    if (!finalByName.has(name)) columnsToDelete.push(name);
  }

  return {
    columnsToAdd,
    columnsToDelete,
    columnsToRename: appliedRenames,
    finalColumns,
    originalColumns,
  };
}

/**
 * Map a legacy MaterializedColumn's FactTableColumnType to the SDKAttribute
 * datatype it corresponds to, or `undefined` if the column can't be
 * represented as an attribute (date / json / other / "" — datatypes the old
 * Managed Warehouse UI allowed but the attribute-driven flow can't express).
 *
 * Used for two things: the one-time legacy-column → attribute backfill, and
 * as a capability test in the sync layer for classifying orphaned snapshot
 * columns as legacy pass-throughs.
 */
export function attributeDatatypeForLegacyColumn(
  datatype: FactTableColumnType,
): SDKAttributeType | undefined {
  switch (datatype) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    // The rest can't round-trip to an attribute cleanly. In practice the old
    // UI only allowed string / number / boolean / "other" (stored as string).
    case "date":
    case "json":
    case "other":
    case "":
      return undefined;
  }
}

/**
 * ClickHouse unquoted identifiers must match this regex — starts with a letter
 * or underscore, followed by alphanumerics or underscores. Anything else
 * (`$`, `.`, spaces, hyphens, leading digits) is invalid unless we quote it,
 * and our DDL generator emits unquoted identifiers.
 */
const CLICKHOUSE_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * SQL keywords that technically work as backticked column names but are
 * confusing enough in query output that we reject them outright. Mirrors the
 * pre-refactor `sanitizeMatColumnName` list.
 */
export const MANAGED_WAREHOUSE_SQL_KEYWORD_BLOCKLIST: ReadonlySet<string> =
  new Set([
    "select",
    "from",
    "where",
    "order",
    "having",
    "limit",
    "offset",
    "join",
    "on",
    "using",
    "as",
    "distinct",
    "union",
    "if",
    "then",
    "else",
    "end",
    "case",
    "when",
    "and",
    "or",
    "not",
    "true",
    "false",
    "null",
    "is",
    "in",
    "between",
    "exists",
    "like",
    "array",
    "tuple",
    "map",
    "cast",
    "inf",
    "infinity",
    "nan",
    "default",
    "current_date",
    "current_timestamp",
    "sysdate",
  ]);

/**
 * Validate that a name is safe to use as an unquoted ClickHouse column name on
 * a Managed Warehouse datasource. Returns `undefined` when valid, or a
 * human-readable error message describing the problem.
 */
const MANAGED_WAREHOUSE_COLUMN_NAME_MAX_LENGTH = 128;

export function validateManagedWarehouseColumnName(
  name: string,
): string | undefined {
  if (name.length > MANAGED_WAREHOUSE_COLUMN_NAME_MAX_LENGTH) {
    return `Attribute name "${name}" is too long for a Managed Warehouse column (max ${MANAGED_WAREHOUSE_COLUMN_NAME_MAX_LENGTH} characters).`;
  }
  if (!CLICKHOUSE_IDENTIFIER_REGEX.test(name)) {
    return `Attribute name "${name}" can't be used as a Managed Warehouse column — names must start with a letter or underscore and contain only alphanumerics and underscores.`;
  }
  const lowered = name.toLowerCase();
  if (RESERVED_MANAGED_WAREHOUSE_COLUMN_NAMES.has(lowered)) {
    return `Attribute name "${name}" collides with a reserved Managed Warehouse column.`;
  }
  if (MANAGED_WAREHOUSE_SQL_KEYWORD_BLOCKLIST.has(lowered)) {
    return `Attribute name "${name}" is a SQL keyword and can't be used as a Managed Warehouse column.`;
  }
  return undefined;
}

/**
 * True iff the column's datatype can't be represented by any SDKAttribute.
 * Pre-refactor ClickHouse warehouses could have columns with datatypes
 * (`date`, `json`, `other`, `""`) that the old UI allowed but the new
 * attribute-driven flow can't express. Such columns are orphans in the sense
 * that no attribute will ever derive them — they're only in the snapshot
 * because migration carried over the legacy `materializedColumns` verbatim.
 *
 * The sync layer uses this to distinguish "orphan because legacy datatype"
 * (preserve as pass-through) from "orphan because the user deleted the
 * attribute" (honest delete). `arrayElementType` short-circuits because array
 * columns only come from post-refactor attributes — if one is orphaned, it's
 * an explicit delete, not a legacy pass-through.
 */
export function isLegacyPassThroughColumn(col: MaterializedColumn): boolean {
  if (col.arrayElementType) return false;
  return attributeDatatypeForLegacyColumn(col.datatype) === undefined;
}

/**
 * Plan the migration of a Managed Warehouse datasource's legacy
 * `settings.materializedColumns` into the organization's attributeSchema.
 * Returns the list of attributes that should be appended (those whose
 * `property` isn't already present) and the list of columns we had to skip
 * because we couldn't map their datatype. Pure; no IO.
 *
 * Warehouse built-ins (geo_*, ua_*, utm_*, url_*, …) are normally maintained
 * outside of attributeSchema — `WAREHOUSE_BUILTIN_COLUMNS` hard-codes them as
 * dimensions — so they're silently dropped from the backfill. The one
 * exception is a built-in that the legacy warehouse promoted to identifier
 * (historically `device_id` was the default identifier on every new managed
 * warehouse). Without an attribute carrying `hashAttribute: true`, the first
 * post-migration sync would see that column's role flip from identifier to
 * dimension, silently removing it from `userIdTypes` and the auto-generated
 * exposure queries — breaking experiment analysis. We backfill those as
 * hashAttribute attributes so the attribute shadow preserves the role.
 */
export function planManagedWarehouseAttributeMigration({
  legacyColumns,
  existingAttributes,
}: {
  legacyColumns: MaterializedColumn[];
  existingAttributes: SDKAttribute[];
}): {
  additions: SDKAttribute[];
  skipped: { columnName: string; reason: string }[];
} {
  const additions: SDKAttribute[] = [];
  const skipped: { columnName: string; reason: string }[] = [];

  const existingByProperty = new Set(existingAttributes.map((a) => a.property));
  const seenInAdditions = new Set<string>();

  for (const col of legacyColumns) {
    // sourceField is the incoming event attribute name; it becomes the
    // attribute's `property`. columnName was historically allowed to differ
    // but in practice new-style attributes always match sourceField.
    const property = col.sourceField;

    // Skip built-ins UNLESS the legacy column was an identifier — see the
    // docstring for why identifier built-ins must round-trip into an attribute.
    if (
      WAREHOUSE_BUILTIN_COLUMN_NAMES.has(property) &&
      col.type !== "identifier"
    ) {
      continue;
    }

    if (existingByProperty.has(property) || seenInAdditions.has(property)) {
      continue;
    }

    const datatype = attributeDatatypeForLegacyColumn(col.datatype);
    if (!datatype) {
      skipped.push({
        columnName: col.columnName,
        reason: `Unmapped datatype "${col.datatype}"`,
      });
      continue;
    }

    additions.push({
      property,
      datatype,
      hashAttribute: col.type === "identifier",
    });
    seenInAdditions.add(property);
  }

  return { additions, skipped };
}
