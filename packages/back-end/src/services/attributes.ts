import { SDKAttribute } from "shared/types/organization";
import { getGrowthbookDatasource } from "back-end/src/models/DataSourceModel";
import { updateOrganization } from "back-end/src/models/OrganizationModel";
import {
  ensureManagedWarehouseAttributesMigrated,
  syncManagedWarehouseAttributes,
} from "back-end/src/services/clickhouseAttributes";
import { logger } from "back-end/src/util/logger";
import { validateManagedWarehouseColumnName } from "back-end/src/util/managedWarehouseAttributes";
import { ReqContext } from "back-end/types/request";

export async function removeTagInAttribute(
  context: ReqContext,
  tag: string,
): Promise<void> {
  const { org } = context;
  const attributeSchema = org.settings?.attributeSchema || [];

  const hasTag = attributeSchema.some((a) => (a.tags || []).includes(tag));
  if (!hasTag) return;

  const updatedAttributeSchema = attributeSchema.map((attr) => ({
    ...attr,
    tags: (attr.tags || []).filter((t) => t !== tag),
  }));

  await updateAttributeSchema(context, {
    newAttributeSchema: updatedAttributeSchema,
  });
}

/**
 * Persist a new attributeSchema on the organization and keep any Managed
 * Warehouse datasource in sync (ClickHouse DDL + derived userIdTypes +
 * exposure queries).
 *
 * If the ClickHouse sync fails we roll the org settings back to the previous
 * value before re-throwing so callers see a consistent failure and don't end
 * up with attributes that have no backing column.
 */
export async function updateAttributeSchema(
  context: ReqContext,
  {
    newAttributeSchema,
    renames = [],
    skipManagedWarehouseNameValidation = false,
  }: {
    newAttributeSchema: SDKAttribute[];
    renames?: { from: string; to: string }[];
    /**
     * Bypass the Managed Warehouse column-name validation. Intended for
     * system-triggered paths (e.g. `$groups` auto-add) where we accept that
     * the attribute won't materialize — `deriveMaterializedColumnsFromAttributes`
     * will silently skip invalid names downstream.
     */
    skipManagedWarehouseNameValidation?: boolean;
  },
): Promise<void> {
  const { org } = context;
  const managedWarehouse = await getGrowthbookDatasource(context);

  // Lazily migrate any legacy Managed Warehouse `materializedColumns` into
  // attributeSchema before doing the user's write. The caller computed
  // `newAttributeSchema` against the pre-migration state, so any attributes
  // that the migration just backfilled would otherwise be dropped from the
  // org. Merge them in — caller's version wins for overlapping properties.
  const migratedAdditions = await ensureManagedWarehouseAttributesMigrated(
    context,
    managedWarehouse,
  );
  if (migratedAdditions.length > 0) {
    const newProperties = new Set(newAttributeSchema.map((a) => a.property));
    newAttributeSchema = [
      ...newAttributeSchema,
      ...migratedAdditions.filter((a) => !newProperties.has(a.property)),
    ];
  }

  const previousAttributeSchema = org.settings?.attributeSchema || [];

  // Reject newly-introduced attribute names that can't be materialized on a
  // Managed Warehouse. Existing attrs are grandfathered (they'll be silently
  // skipped by derive) so previously-accepted names don't start blocking
  // unrelated attribute edits. Only runs when the org has a Managed Warehouse.
  if (managedWarehouse && !skipManagedWarehouseNameValidation) {
    const previousProperties = new Set(
      previousAttributeSchema.map((a) => a.property),
    );
    for (const attr of newAttributeSchema) {
      if (previousProperties.has(attr.property)) continue;
      const reason = validateManagedWarehouseColumnName(attr.property);
      if (reason) throw new Error(reason);
    }
  }

  await updateOrganization(org.id, {
    settings: { ...org.settings, attributeSchema: newAttributeSchema },
  });

  if (managedWarehouse) {
    try {
      await syncManagedWarehouseAttributes(context, managedWarehouse, {
        attributeSchema: newAttributeSchema,
        renames,
      });
    } catch (e) {
      // If the sync threw after DDL ran but before the snapshot write landed,
      // ClickHouse is now ahead of the snapshot. Rollback reverts attributeSchema,
      // so the next sync sees `originalColumns == finalColumns` and is a no-op —
      // the extra CH columns become orphans that no future sync will diff away.
      // Expected to be rare (requires post-DDL Mongo failure inside the sync);
      // log with enough context that Sentry surfacing lets us reconcile by hand.
      logger.error(
        {
          err: e,
          orgId: org.id,
          datasourceId: managedWarehouse.id,
          attemptedAttributeProperties: newAttributeSchema.map(
            (a) => a.property,
          ),
          rolledBackToAttributeProperties: previousAttributeSchema.map(
            (a) => a.property,
          ),
          renames,
        },
        "Managed Warehouse sync failed; rolling back attributeSchema. ClickHouse may be ahead of the snapshot — inspect manually if orphan columns are suspected.",
      );
      await rollbackAttributeSchema(context, previousAttributeSchema);
      throw e;
    }
  }
}

/**
 * Restore the org's attributeSchema to its pre-edit value after a failed
 * Managed Warehouse sync, so callers don't end up with attributes that have
 * no backing column.
 *
 * `previousAttributeSchema` is the post-migration schema (read after
 * `ensureManagedWarehouseAttributesMigrated` ran), not the true pre-request
 * state. That's intentional: the migration is one-way and idempotent, and a
 * subsequent attribute write against the backfilled schema is a no-op diff.
 * We're rolling the user's requested edit back, not the migration.
 */
async function rollbackAttributeSchema(
  context: ReqContext,
  previousAttributeSchema: SDKAttribute[],
): Promise<void> {
  try {
    await updateOrganization(context.org.id, {
      settings: {
        ...context.org.settings,
        attributeSchema: previousAttributeSchema,
      },
    });
  } catch (rollbackError) {
    logger.error(
      rollbackError,
      "Failed to roll back attributeSchema after Managed Warehouse sync failure",
    );
  }
}
