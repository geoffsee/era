import { createTestAccuracyService, createTestDatabase } from "../../../test/helpers/accuracy.ts";
import { expect, test } from "bun:test";
import { CalibrationRepository } from "../repositories/calibration-repository.ts";
import { PredictionRepository } from "../repositories/prediction-repository.ts";
import { CalibrationService } from "./calibration-service.ts";

const NOW = "2026-10-05T00:00:00.000Z";
const extract = { gammaPerPoint: 80, sampleCount: 4, lanes: ["T01"] };

test("revise reads the ledger, stores one vector per repository, and keeps the snapshot when nothing changed", async () => {
    const db = createTestDatabase();
    const accuracy = createTestAccuracyService(db);
    const repository = new CalibrationRepository(db);
    const predictions = new PredictionRepository(db);
    const service = new CalibrationService(repository, predictions);

    const initial = await service.revise("octo/example", extract, NOW);
    expect(initial.scale).toBe(1);
    expect(initial.gamma).toBeNull();
    expect(initial.factors.gamma.value).toBe(80);

    await accuracy.recordPredictions(
        [
            {
                repository: "octo/example",
                subject: "issue:1",
                model: "token-threshold",
                metric: "tokens",
                predicted: 100,
                lane: "T01",
            },
            {
                repository: "octo/example",
                subject: "issue:2",
                model: "token-threshold",
                metric: "tokens",
                predicted: 100,
                lane: "T01",
            },
        ],
        NOW,
    );
    await accuracy.recordObservations(
        [
            { repository: "octo/example", subject: "issue:1", metric: "tokens", actual: 200 },
            { repository: "octo/example", subject: "issue:2", metric: "tokens", actual: 200 },
        ],
        NOW,
    );

    const fitted = await service.revise("octo/example", extract, "2026-10-06T00:00:00.000Z");
    expect(fitted.factors.scale.identified).toBe(true);
    expect(fitted.scale).toBeGreaterThan(1.4);
    expect(fitted.scale).toBeLessThan(1.5);
    expect(fitted.lanes.T01).toBeCloseTo(1);
    expect(fitted.lanes.T01).toBeCloseTo(1);
    expect(fitted.snapshotId).not.toBe(initial.snapshotId);
    const stored = await repository.findForRepository("octo/example");
    expect(stored?.snapshotId).toBe(fitted.snapshotId);
    expect(stored?.factors.scale.value).toBe(fitted.scale);

    const reread = await service.revise("octo/example", extract, "2026-10-06T00:00:00.000Z");
    expect(reread.snapshotId).toBe(fitted.snapshotId);
    expect((await repository.findForRepository("octo/example"))?.updatedAt).toBe(stored?.updatedAt);

    const later = await service.revise("octo/example", extract, "2026-10-20T00:00:00.000Z");
    expect(later.snapshotId).not.toBe(fitted.snapshotId);
    expect(later.scale).not.toBe(fitted.scale);
});
