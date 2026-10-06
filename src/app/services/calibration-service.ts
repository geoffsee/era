import { CalibrationRepository } from "../repositories/calibration-repository.ts";
import { PredictionRepository } from "../repositories/prediction-repository.ts";
import { Component, Container } from "@di-framework/core/decorators";
import {
    calibrationSnapshotId,
    type CalibrationOverride,
    type ExtractFactors,
    fitFactors,
    overrideFrom,
    storyPointIndex,
} from "../../core/forecast/calibration.ts";

@Container()
export class CalibrationService {
    constructor(
        @Component(CalibrationRepository) private readonly calibrations: CalibrationRepository,
        @Component(PredictionRepository) private readonly predictions: PredictionRepository,
    ) {}

    /**
     * Reads the stored vector. A changed blend replaces it and mints a new snapshot id;
     * an unchanged blend keeps the snapshot the last estimate recorded against.
     */
    async revise(repository: string, extract: ExtractFactors, now: string): Promise<CalibrationOverride> {
        const [pairs, predictions] = await Promise.all([
            this.predictions.ledgerPairs(repository),
            this.predictions.findForRepository(repository),
        ]);
        const factors = fitFactors(extract, pairs, storyPointIndex(pairs, predictions), now);
        const snapshotId = calibrationSnapshotId(factors);
        const current = await this.calibrations.findForRepository(repository);
        if (current?.snapshotId === snapshotId) return overrideFrom(current);
        await this.calibrations.save({ repository, snapshotId, factors, updatedAt: now });
        return overrideFrom({ snapshotId, factors });
    }
}
