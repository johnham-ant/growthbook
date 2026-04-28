import * as crypto from "crypto";
import { createClient as createClickhouseClient } from "@clickhouse/client";
import generator from "generate-password";
import { AIPromptType } from "shared/ai";
import { MANAGED_WAREHOUSE_EVENTS_FACT_TABLE_ID } from "shared/constants";
import { SDKConnectionInterface } from "shared/types/sdk-connection";
import {
  GrowthbookClickhouseDataSource,
  DataSourceParams,
  MaterializedColumn,
} from "shared/types/datasource";
import { DailyUsage } from "shared/types/organization";
import { parseIntWithDefault } from "shared/util";
import {
  FactTableColumnType,
  FactTableInterface,
} from "shared/types/fact-table";
import {
  ClickHouseDataType,
  isLegacyPassThroughColumn,
  MANAGED_WAREHOUSE_REMAINING_COLUMNS,
  WAREHOUSE_BUILTIN_FIELD_TYPES,
} from "back-end/src/util/managedWarehouseAttributes";
import {
  CLICKHOUSE_HOST,
  CLICKHOUSE_ADMIN_USER,
  CLICKHOUSE_ADMIN_PASSWORD,
  CLICKHOUSE_DATABASE,
  CLICKHOUSE_MAIN_TABLE,
  ENVIRONMENT,
  IS_CLOUD,
  CLICKHOUSE_DEV_PREFIX,
  CLICKHOUSE_OVERAGE_TABLE,
  MANAGED_CLICKHOUSE_USE_LICENSE_SERVER,
} from "back-end/src/util/secrets";
import type { ReqContext } from "back-end/types/request";
import { logger } from "back-end/src/util/logger";
import {
  getFactTablesForDatasource,
  updateFactTableColumns,
} from "back-end/src/models/FactTableModel";
import {
  getGrowthbookDatasource,
  lockDataSource,
  unlockDataSource,
  updateDataSource,
} from "back-end/src/models/DataSourceModel";
import {
  addCloudSDKMappingViaLicenseServer,
  createClickhouseUserViaLicenseServer,
  dangerousRecreateClickhouseTablesViaLicenseServer,
  deleteClickhouseUserViaLicenseServer,
  migrateOverageEventsForOrgIdViaLicenseServer,
  updateMaterializedColumnsInClickhouseViaLicenseServer,
} from "back-end/src/services/licenseServerManagedClickhouse";
import {
  ensureManagedWarehouseAttributesMigrated,
  extractColumnNameOverrides,
  getWarehouseMaterializedColumns,
} from "back-end/src/services/clickhouseAttributes";

function clickhouseUserId(orgId: string) {
  // Sanity check. An orgId of `default` or another reserved word would seriously mess things up
  if (!orgId.startsWith("org_")) {
    throw new Error("Invalid organization id");
  }

  return ENVIRONMENT === "production"
    ? `${orgId}`
    : `${CLICKHOUSE_DEV_PREFIX}${orgId}`;
}

function ensureClickhouseEnvVars() {
  if (
    !CLICKHOUSE_HOST ||
    !CLICKHOUSE_ADMIN_USER ||
    !CLICKHOUSE_ADMIN_PASSWORD ||
    !CLICKHOUSE_DATABASE ||
    !CLICKHOUSE_MAIN_TABLE
  ) {
    throw new Error(
      "Must specify necessary environment variables to interact with clickhouse.",
    );
  }
}

function createAdminClickhouseClient() {
  ensureClickhouseEnvVars();
  return createClickhouseClient({
    host: CLICKHOUSE_HOST,
    username: CLICKHOUSE_ADMIN_USER,
    password: CLICKHOUSE_ADMIN_PASSWORD,
    database: CLICKHOUSE_DATABASE,
    application: "GrowthBook",
    request_timeout: 3620_000,
    clickhouse_settings: {
      max_execution_time: 3600,
    },
  });
}

function getClickhouseDatatype(
  columnType: FactTableColumnType,
  arrayElementType?: "string" | "number",
): ClickHouseDataType {
  if (arrayElementType === "string") return "Array(String)";
  if (arrayElementType === "number") return "Array(Float64)";
  switch (columnType) {
    case "date":
      return "DateTime";
    case "number":
      return "Float64";
    case "boolean":
      return "Boolean";
    default:
      return "String";
  }
}

function getClickhouseExtractClause(
  sourceField: string,
  columnType: FactTableColumnType,
  arrayElementType?: "string" | "number",
) {
  // Array extraction always goes through context_json — top-level fields are
  // never array-typed today.
  if (arrayElementType) {
    const chType = getClickhouseDatatype(columnType, arrayElementType);
    return `JSONExtract(context_json, '${sourceField}', '${chType}')`;
  }

  // Warehouse built-ins live at the top level of the `events` table (populated
  // by the ingestor), not inside `context_json`. Reference the column directly,
  // casting only if the stored type differs from the requested fact-table type.
  if (WAREHOUSE_BUILTIN_FIELD_TYPES[sourceField]) {
    const desiredDataType = getClickhouseDatatype(columnType);

    // If the desired data type is different from the actual type, need to cast it
    if (desiredDataType !== WAREHOUSE_BUILTIN_FIELD_TYPES[sourceField]) {
      return `CAST(${sourceField} AS ${desiredDataType})`;
    }

    // Otherwise, just return the column name
    return sourceField;
  }

  switch (columnType) {
    case "number":
      return `JSONExtractFloat(context_json, '${sourceField}')`;
    case "boolean":
      return `JSONExtractBool(context_json, '${sourceField}')`;
    default:
      return `JSONExtractString(context_json, '${sourceField}')`;
  }
}

type ColumnDef = {
  source: string;
  alias?: string;
  datatype: ClickHouseDataType;
};

function getCreateTableColumnList(columns: ColumnDef[]): string[] {
  return columns.map(
    ({ source, alias, datatype }) => `${alias || source} ${datatype}`,
  );
}
function getSelectColumnList(columns: ColumnDef[]): string[] {
  return columns.map(
    ({ source, alias }) =>
      `${source}${alias && alias !== source ? ` as ${alias}` : ""}`,
  );
}

function getRemainingColumnDefs(): ColumnDef[] {
  return Object.entries(MANAGED_WAREHOUSE_REMAINING_COLUMNS).map(
    ([colName, colType]) => ({
      source: colName,
      datatype: colType,
    }),
  );
}

function getMaterializedColumnDefs(
  materializedColumns: MaterializedColumn[],
): ColumnDef[] {
  return materializedColumns.map(
    ({ columnName, datatype, sourceField, arrayElementType }) => ({
      source: getClickhouseExtractClause(
        sourceField,
        datatype,
        arrayElementType,
      ),
      alias: columnName,
      datatype: getClickhouseDatatype(datatype, arrayElementType),
    }),
  );
}

function getMaterializedViewSQL({
  orgId,
  colDefs,
  orderBy,
  filter,
  baseTableName,
}: {
  orgId: string;
  colDefs: ColumnDef[];
  orderBy: string;
  filter: string;
  baseTableName: string;
}): {
  createTable: string;
  createView: string;
  populateTable: string;
  select: string;
  tableName: string;
  viewName: string;
} {
  const tableName = getTableName(orgId, baseTableName);
  const viewName = getTableName(orgId, `${baseTableName}_mv`);

  const createTable = `CREATE TABLE ${tableName} (
  ${getCreateTableColumnList(colDefs).join(",\n  ")}
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp) 
ORDER BY ${orderBy}`;

  const select = `SELECT ${getSelectColumnList(colDefs).join(", ")}
    FROM ${CLICKHOUSE_MAIN_TABLE} 
    WHERE (organization = '${orgId}') AND (${filter})`;

  const populateTable = `INSERT INTO ${tableName} ${select}`;
  const createView = `CREATE MATERIALIZED VIEW ${viewName} TO ${tableName} 
DEFINER=CURRENT_USER SQL SECURITY DEFINER
AS ${select}`;

  return {
    createTable,
    select,
    populateTable,
    createView,
    tableName,
    viewName,
  };
}

function getEventsSQL(
  orgId: string,
  materializedColumns: MaterializedColumn[],
) {
  return getMaterializedViewSQL({
    orgId,
    baseTableName: "events",
    filter: "event_name NOT IN ('Experiment Viewed', 'Feature Evaluated')",
    orderBy: "(event_name, timestamp)",
    colDefs: [
      { source: "timestamp", datatype: "DateTime" },
      { source: "client_key", datatype: "String" },
      { source: "event_name", datatype: "String" },
      { source: "properties_json", alias: "properties", datatype: "String" },
      { source: "context_json", alias: "attributes", datatype: "String" },
      ...getRemainingColumnDefs(),
      ...getMaterializedColumnDefs(materializedColumns),
    ],
  });
}

function getExperimentViewSQL(
  orgId: string,
  materializedColumns: MaterializedColumn[],
) {
  return getMaterializedViewSQL({
    orgId,
    baseTableName: "experiment_views",
    filter: "event_name = 'Experiment Viewed'",
    orderBy: "(experiment_id, timestamp)",
    colDefs: [
      { source: "timestamp", datatype: "DateTime" },
      { source: "client_key", datatype: "String" },
      {
        source: "JSONExtractString(properties_json, 'experimentId')",
        alias: "experiment_id",
        datatype: "String",
      },
      {
        source: "JSONExtractString(properties_json, 'variationId')",
        alias: "variation_id",
        datatype: "String",
      },
      { source: "properties_json", alias: "properties", datatype: "String" },
      { source: "context_json", alias: "attributes", datatype: "String" },
      ...getRemainingColumnDefs(),
      ...getMaterializedColumnDefs(materializedColumns),
    ],
  });
}

function getFeatureusageSQL(orgId: string) {
  return getMaterializedViewSQL({
    orgId,
    baseTableName: "feature_usage",
    filter: "event_name = 'Feature Evaluated'",
    orderBy: "(feature, timestamp)",
    colDefs: [
      { source: "timestamp", datatype: "DateTime" },
      { source: "client_key", datatype: "String" },
      {
        source: "JSONExtractString(properties_json, 'feature')",
        alias: "feature",
        datatype: "String",
      },
      {
        source: "JSONExtractString(properties_json, 'revision')",
        alias: "revision",
        datatype: "String",
      },
      {
        source: "JSONExtractString(properties_json, 'source')",
        alias: "source",
        datatype: "String",
      },
      {
        source: "JSONExtractString(properties_json, 'value')",
        alias: "value",
        datatype: "String",
      },
      {
        source: "JSONExtractString(properties_json, 'ruleId')",
        alias: "ruleId",
        datatype: "String",
      },
      {
        source: "JSONExtractString(properties_json, 'variationId')",
        alias: "variationId",
        datatype: "String",
      },
      { source: "context_json", alias: "attributes", datatype: "String" },
      ...getRemainingColumnDefs(),
    ],
  });
}

async function runCommand(
  client: ReturnType<typeof createClickhouseClient>,
  query: string,
): Promise<void> {
  await client.command({ query });
}

function getTableName(orgId: string, name: string) {
  const user = clickhouseUserId(orgId);
  const database = user;
  return `${database}.${name}`;
}

export async function createClickhouseUser(
  context: ReqContext,
  materializedColumns: MaterializedColumn[] = [],
): Promise<DataSourceParams> {
  if (MANAGED_CLICKHOUSE_USE_LICENSE_SERVER) {
    return createClickhouseUserViaLicenseServer(
      context.org.id,
      materializedColumns,
    );
  }

  const client = createAdminClickhouseClient();

  const orgId = context.org.id;
  const user = clickhouseUserId(orgId);
  const password = generator.generate({
    length: 30,
    numbers: true,
  });
  const hashedPassword = crypto
    .createHash("sha256")
    .update(password)
    .digest("hex");

  const database = user;
  logger.info(`creating Clickhouse database ${database}`);
  // It's important this does not have "IF NOT EXISTS" to protect against race conditions
  await runCommand(client, `CREATE DATABASE ${database}`);

  logger.info(`Creating Clickhouse user ${user}`);
  await runCommand(
    client,
    `CREATE USER ${user} IDENTIFIED WITH sha256_hash BY '${hashedPassword}' DEFAULT DATABASE ${database}`,
  );

  await createClickhouseTables(client, orgId, materializedColumns);

  logger.info(
    `Granting select permissions on information_schema.columns to ${user}`,
  );
  // For schema browser.  They can only see info on tables that they have select permissions on.
  await runCommand(
    client,
    `GRANT SELECT(data_type, table_name, table_catalog, table_schema, column_name) ON information_schema.columns TO ${user}`,
  );

  const url = new URL(CLICKHOUSE_HOST);

  const params = {
    port: parseIntWithDefault(url.port, 9000),
    url: url.toString(),
    user: user,
    password: password,
    database: database,
  };

  return params;
}

export async function createClickhouseTables(
  client: ReturnType<typeof createAdminClickhouseClient>,
  orgId: string,
  materializedColumns: MaterializedColumn[] = [],
): Promise<void> {
  const user = clickhouseUserId(orgId);
  const database = user;

  // Events table
  const eventsSQL = getEventsSQL(orgId, materializedColumns);
  logger.info(`Creating table ${eventsSQL.tableName}`);
  await runCommand(client, eventsSQL.createTable);
  logger.info(`Populating table ${eventsSQL.tableName}`);
  await runCommand(client, eventsSQL.populateTable);
  logger.info(`Creating materialized view ${eventsSQL.viewName}`);
  await runCommand(client, eventsSQL.createView);

  // Experiment views table
  const experimentViewSQL = getExperimentViewSQL(orgId, materializedColumns);
  logger.info(`Creating table ${experimentViewSQL.tableName}`);
  await runCommand(client, experimentViewSQL.createTable);
  logger.info(`Populating table ${experimentViewSQL.tableName}`);
  await runCommand(client, experimentViewSQL.populateTable);
  logger.info(`Creating materialized view ${experimentViewSQL.viewName}`);
  await runCommand(client, experimentViewSQL.createView);

  // Feature usage table
  const featureUsageSQL = getFeatureusageSQL(orgId);
  logger.info(`Creating table ${featureUsageSQL.tableName}`);
  await runCommand(client, featureUsageSQL.createTable);
  logger.info(`Populating table ${featureUsageSQL.tableName}`);
  await runCommand(client, featureUsageSQL.populateTable);
  logger.info(`Creating materialized view ${featureUsageSQL.viewName}`);
  await runCommand(client, featureUsageSQL.createView);

  logger.info(`Granting select permissions on ${database}.* to ${user}`);
  await runCommand(client, `GRANT SELECT ON ${database}.* TO ${user}`);
}

export async function dangerousRecreateClickhouseTables(
  context: ReqContext,
  datasource: GrowthbookClickhouseDataSource,
): Promise<void> {
  const orgId = context.org.id;

  // Backfilling data can take a while, so lock the datasource for 30 minutes.
  // Lock before migrating so a concurrent attribute-sync can't interleave
  // between migration's snapshot seed and our recreate acquiring the lock.
  await lockDataSource(context, datasource, 1800);

  try {
    // If this datasource is still in the legacy representation, migrate first
    // so the recreated tables match the attributeSchema source of truth.
    await ensureManagedWarehouseAttributesMigrated(context, datasource);

    // Re-fetch after migration: `datasource` is stale (migration
    // updates the DB but not this copy), and we need the freshly-seeded
    // `syncedMaterializedColumns` snapshot for override extraction.
    const freshDatasource = await getGrowthbookDatasource(context);
    if (!freshDatasource) {
      throw new Error(
        "Managed Warehouse datasource disappeared during recreate",
      );
    }

    // Preserve any historical `sourceField → columnName` mapping recorded in
    // the snapshot so a recreate doesn't silently rename legacy columns.
    const snapshot = freshDatasource.settings.syncedMaterializedColumns || [];
    const columnNameOverrides = extractColumnNameOverrides(snapshot);
    const attributeAndBuiltinColumns = getWarehouseMaterializedColumns(
      context.org.settings?.attributeSchema || [],
      { columnNameOverrides, orgId: context.org.id },
    );
    // Preserve pass-through columns (legacy datatypes that don't map to any
    // attribute: date / json / other / ""). Recreate would otherwise drop
    // them along with their data.
    const knownColumnNames = new Set(
      attributeAndBuiltinColumns.map((c) => c.columnName),
    );
    const passThroughColumns = snapshot.filter(
      (c) =>
        isLegacyPassThroughColumn(c) && !knownColumnNames.has(c.columnName),
    );
    const materializedColumns = [
      ...attributeAndBuiltinColumns,
      ...passThroughColumns,
    ];

    if (MANAGED_CLICKHOUSE_USE_LICENSE_SERVER) {
      await dangerousRecreateClickhouseTablesViaLicenseServer(
        orgId,
        materializedColumns,
      );
    } else {
      const client = createAdminClickhouseClient();
      const user = clickhouseUserId(orgId);
      const database = user;

      // Drop the entire database and recreate it
      logger.info(`Dropping Clickhouse database ${database}`);
      await runCommand(client, `DROP DATABASE IF EXISTS ${database}`);

      logger.info(`Creating Clickhouse database ${database}`);
      await runCommand(client, `CREATE DATABASE ${database}`);

      await createClickhouseTables(client, orgId, materializedColumns);
    }

    // Reset the snapshot — the recreate is also the intended escape hatch for
    // recovering from drift, and we want subsequent syncs to compare against
    // the fresh ClickHouse state.
    await updateDataSource(context, freshDatasource, {
      settings: {
        ...freshDatasource.settings,
        syncedMaterializedColumns: materializedColumns,
      },
    });
  } finally {
    await unlockDataSource(context, datasource);
  }
}

export async function deleteClickhouseUser(organization: string) {
  if (MANAGED_CLICKHOUSE_USE_LICENSE_SERVER) {
    return deleteClickhouseUserViaLicenseServer(organization);
  }

  const client = createAdminClickhouseClient();
  const user = clickhouseUserId(organization);
  const database = user;

  logger.info(`Deleting Clickhouse user ${user}`);
  await runCommand(client, `DROP USER IF EXISTS ${user}`);

  logger.info(`Deleting Clickhouse database ${database}`);
  await runCommand(client, `DROP DATABASE IF EXISTS ${database}`);
}

export async function addCloudSDKMapping(connection: SDKConnectionInterface) {
  const { key, organization } = connection;

  // This is not a fatal error, so just log instead of throwing
  try {
    if (MANAGED_CLICKHOUSE_USE_LICENSE_SERVER) {
      await addCloudSDKMappingViaLicenseServer(key, organization);
    } else {
      const client = createAdminClickhouseClient();
      await client.insert({
        table: "usage.sdk_key_mapping",
        values: [{ key, organization }],
        format: "JSONEachRow",
      });
    }
  } catch (e) {
    logger.error(
      e,
      `Error inserting sdk key mapping (${key} -> ${organization})`,
    );
  }
}

export async function migrateOverageEventsForOrgId(orgId: string) {
  if (MANAGED_CLICKHOUSE_USE_LICENSE_SERVER) {
    return migrateOverageEventsForOrgIdViaLicenseServer(orgId);
  }

  const client = createAdminClickhouseClient();
  await runCommand(
    client,
    `INSERT INTO ${CLICKHOUSE_MAIN_TABLE} SELECT * FROM ${CLICKHOUSE_OVERAGE_TABLE} WHERE organization = '${orgId}'`,
  );
  await runCommand(
    client,
    `ALTER TABLE ${CLICKHOUSE_OVERAGE_TABLE} DELETE WHERE organization = '${orgId}'`,
  );
}

// In order to monitor usage and quality of AI responses on cloud we log each request to AI agents
export async function logCloudAIUsage({
  organization,
  type,
  model,
  temperature,
  numPromptTokensUsed,
  numCompletionTokensUsed,
  usedDefaultPrompt,
}: {
  organization: string;
  model: string;
  numPromptTokensUsed?: number;
  numCompletionTokensUsed?: number;
  type: AIPromptType;
  temperature?: number;
  usedDefaultPrompt: boolean;
}): Promise<void> {
  if (!IS_CLOUD) {
    // This is only for cloud
    return;
  }

  const env = ENVIRONMENT === "production" ? "prod" : ENVIRONMENT;
  // As this is just for logging, there is no need to make this a fatal error if it fails
  try {
    const client = createAdminClickhouseClient();
    await client.insert({
      table: "usage.ai_usage",
      values: [
        {
          env,
          organization,
          type,
          model,
          num_prompt_tokens_used: numPromptTokensUsed,
          num_completion_tokens_used: numCompletionTokensUsed,
          temperature,
          used_default_prompt: usedDefaultPrompt,
          date_created: new Date(),
        },
      ],
      format: "JSONEachRow",
    });
  } catch (e) {
    logger.error(e, "Failed to log AI usage to Clickhouse");
  }
}

export async function getDailyUsageForOrg(
  orgId: string,
  start: Date,
  end: Date,
): Promise<DailyUsage[]> {
  const client = createAdminClickhouseClient();

  // orgId is coming from the back-end, so this should not be necessary, but just in case
  const sanitizedOrgId = orgId.replace(/[^a-zA-Z0-9_-]/g, "");

  const startString = start.toISOString().replace("T", " ").substring(0, 19);
  const endString = end.toISOString().replace("T", " ").substring(0, 19);

  // Don't fill forward beyond the current date
  const fillEnd = end > new Date() ? new Date() : end;
  const fillEndString = fillEnd
    .toISOString()
    .replace("T", " ")
    .substring(0, 19);

  const sql = `
select
  date,
  sum(requests) as requests,
  sum(bandwidth) as bandwidth,
  sum(managedClickhouseEvents) as managedClickhouseEvents
from (
  select
    toStartOfDay(hour) as date,
    sum(requests) as requests,
    sum(bandwidth) as bandwidth,
    0 as managedClickhouseEvents
  from usage.cdn_hourly
  where
    organization = '${sanitizedOrgId}'
    AND date BETWEEN '${startString}' AND '${endString}'
  group by date
  
  union all
  
  select
    toStartOfDay(received_at) as date,
    0 as requests,
    0 as bandwidth,
    count(1) as managedClickhouseEvents
  from ${CLICKHOUSE_MAIN_TABLE}
  where
    organization = '${sanitizedOrgId}'
    AND received_at BETWEEN '${startString}' AND '${endString}'
  group by date
  
  union all
  
  select
    toStartOfDay(received_at) as date,
    0 as requests,
    0 as bandwidth,
    count(1) as managedClickhouseEvents
  from ${CLICKHOUSE_OVERAGE_TABLE}
  where
    organization = '${sanitizedOrgId}'
    AND received_at BETWEEN '${startString}' AND '${endString}'
  group by date
)
group by date
order by date ASC
WITH FILL
  FROM toDateTime('${startString}')
  TO toDateTime('${fillEndString}')
  STEP toIntervalDay(1)
  `.trim();

  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
  });

  const data: {
    date: string;
    // These are returned as strings because they could in theory be bigger than MAX_SAFE_INTEGER
    // That is very unlikely, and even if it happens it will still be approximately correct
    requests: string;
    bandwidth: string;
    managedClickhouseEvents: string;
  }[] = await res.json();

  // Convert strings to numbers for all metrics
  return data.map((d) => ({
    date: d.date,
    requests: parseIntWithDefault(d.requests, 0),
    bandwidth: parseIntWithDefault(d.bandwidth, 0),
    managedClickhouseEvents: parseIntWithDefault(d.managedClickhouseEvents, 0),
  }));
}

type MaterializedViewBuilder = (
  orgId: string,
  columns: MaterializedColumn[],
) => { tableName: string; viewName: string; createView: string };

/**
 * Apply an ALTER TABLE to a materialized view's underlying table. The view
 * must be dropped before the ALTER and recreated after, whether or not the
 * ALTER succeeds — otherwise queries against the view fail.
 *
 * We swallow the ALTER error and rethrow after the view is restored so the
 * finally-block's own failures don't mask the real error. On ALTER failure
 * the view is rebuilt against the original columns (unchanged CH schema);
 * on success it's rebuilt against the new columns.
 */
async function alterTableAndRecreateView(
  client: ReturnType<typeof createAdminClickhouseClient>,
  orgId: string,
  buildSQL: MaterializedViewBuilder,
  clauses: string,
  originalColumns: MaterializedColumn[],
  finalColumns: MaterializedColumn[],
) {
  const { tableName, viewName } = buildSQL(orgId, []);
  logger.info(`Updating materialized columns; dropping view ${viewName}`);
  await runCommand(client, `DROP VIEW IF EXISTS ${viewName}`);

  let viewColumns = originalColumns;
  let alterError: unknown;
  try {
    logger.info(`Updating table schema for ${tableName}`);
    await runCommand(client, `ALTER TABLE ${tableName} ${clauses}`);
    viewColumns = finalColumns;
  } catch (e) {
    logger.error(e);
    alterError = e;
  } finally {
    logger.info(`Recreating materialized view ${viewName}`);
    await runCommand(client, buildSQL(orgId, viewColumns).createView);
  }
  if (alterError) throw alterError;
}

function applyColumnChangesToFactTable(
  existingColumns: FactTableInterface["columns"],
  columnsToAdd: MaterializedColumn[],
  columnsToDelete: string[],
  columnsToRename: { from: string; to: string }[],
): FactTableInterface["columns"] {
  const now = new Date();
  const next = existingColumns.map((col) => ({
    ...col,
    numberFormat: col.numberFormat ?? "",
  }));

  for (const col of columnsToAdd) {
    const existing = next.find((c) => c.column === col.columnName);
    if (existing) {
      // Restore a previously-removed column.
      existing.deleted = false;
      existing.dateUpdated = now;
    } else {
      next.push({
        column: col.columnName,
        name: col.columnName,
        datatype: col.datatype,
        dateCreated: now,
        dateUpdated: now,
        deleted: false,
        description: "",
        numberFormat: "",
      });
    }
  }

  for (const { from, to } of columnsToRename) {
    const col = next.find((c) => c.column === from);
    if (!col) continue;
    const destination = next.find((c) => c.column === to);
    if (destination) {
      // Destination already exists — restore it and tombstone the source.
      destination.deleted = false;
      destination.dateUpdated = now;
      col.deleted = true;
      col.dateUpdated = now;
    } else {
      col.column = to;
      col.name = to;
      col.dateUpdated = now;
    }
  }

  for (const name of columnsToDelete) {
    const col = next.find((c) => c.column === name);
    if (col) {
      col.deleted = true;
      col.dateUpdated = now;
    }
  }

  return next;
}

/**
 * @internal — does NOT acquire the datasource lock. Callers are responsible for
 * holding the lock for the whole read-compute-write sequence
 * (`syncedMaterializedColumns` → diff → DDL → snapshot write). The only caller
 * today is `syncManagedWarehouseAttributes`, which locks around this. The
 * `dangerous` prefix is a warning: adding a new caller without locking will
 * re-introduce the concurrent-write race this was designed around.
 */
export async function dangerousUpdateMaterializedColumns({
  context,
  datasource,
  columnsToAdd,
  columnsToDelete,
  columnsToRename,
  finalColumns,
  originalColumns,
}: {
  context: ReqContext;
  datasource: GrowthbookClickhouseDataSource;
  columnsToAdd: MaterializedColumn[];
  columnsToDelete: string[];
  columnsToRename: { from: string; to: string }[];
  finalColumns: MaterializedColumn[];
  originalColumns: MaterializedColumn[];
}) {
  const orgId = datasource.organization;

  if (MANAGED_CLICKHOUSE_USE_LICENSE_SERVER) {
    await updateMaterializedColumnsInClickhouseViaLicenseServer({
      orgId,
      columnsToAdd,
      columnsToDelete,
      columnsToRename,
      finalColumns,
      originalColumns,
    });
  } else {
    const client = createAdminClickhouseClient();

    const addClauses = columnsToAdd.map(
      ({ columnName, datatype, arrayElementType }) =>
        `ADD COLUMN IF NOT EXISTS ${columnName} ${getClickhouseDatatype(
          datatype,
          arrayElementType,
        )}`,
    );
    const dropClauses = columnsToDelete.map(
      (columnName) => `DROP COLUMN IF EXISTS ${columnName}`,
    );
    const renameClauses = columnsToRename.map(
      ({ from, to }) => `RENAME COLUMN ${from} to ${to}`,
    );
    const clauses = [...addClauses, ...dropClauses, ...renameClauses].join(
      ", ",
    );

    await alterTableAndRecreateView(
      client,
      orgId,
      getEventsSQL,
      clauses,
      originalColumns,
      finalColumns,
    );
    await alterTableAndRecreateView(
      client,
      orgId,
      getExperimentViewSQL,
      clauses,
      originalColumns,
      finalColumns,
    );
  }

  // Update the main events fact table with the new columns
  const factTables = await getFactTablesForDatasource(context, datasource.id);
  const ft = factTables.find(
    (ft) => ft.id === MANAGED_WAREHOUSE_EVENTS_FACT_TABLE_ID,
  );
  if (ft) {
    const newColumns = applyColumnChangesToFactTable(
      ft.columns,
      columnsToAdd,
      columnsToDelete,
      columnsToRename,
    );
    const newIdentifierTypes = finalColumns
      .filter((col) => col.type === "identifier")
      .map((col) => col.columnName);

    await updateFactTableColumns(
      ft,
      { columns: newColumns, userIdTypes: newIdentifierTypes },
      context,
    );
  }
}
