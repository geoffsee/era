import { Component } from "@di-framework/core/decorators";
import { EntityRepository, Repository } from "@di-framework/repo/portable";
import { CompositeSqlAdapter } from "../../core/persistence/composite-sql-adapter.ts";
import type { SqlDatabase } from "../../core/persistence/database.ts";
import { storedFactors, type StoredCalibration } from "../../core/forecast/calibration.ts";
import { SQL_DATABASE } from "../configuration.ts";

@Repository()
export class CalibrationRepository extends EntityRepository<StoredCalibration, string> {
    declare protected readonly adapter: CompositeSqlAdapter<StoredCalibration>;

    constructor(@Component(SQL_DATABASE) db: SqlDatabase) {
        super(
            new CompositeSqlAdapter(
                db,
                {
                    table: "calibrations",
                    entityToRow: ({ snapshotId, factors, updatedAt, ...row }) => ({
                        ...row,
                        snapshot_id: snapshotId,
                        factors: JSON.stringify(factors),
                        updated_at: updatedAt,
                    }),
                    rowToEntity: (row) => ({
                        repository: row.repository as string,
                        snapshotId: row.snapshot_id as string,
                        factors: storedFactors(JSON.parse(row.factors as string)),
                        updatedAt: row.updated_at as string,
                    }),
                },
                ["repository"],
            ),
        );
    }

    findForRepository(repository: string): Promise<StoredCalibration | null> {
        return this.findById(JSON.stringify([repository]));
    }
}
