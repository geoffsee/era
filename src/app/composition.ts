import { AccuracyService } from "../services/accuracy-service.ts";
import { SQL_DATABASE, type SqlDatabase } from "../persistence/database.ts";
import { useContainer } from "@di-framework/core/container";
import { ForecastController } from "../controllers/forecast-controller.ts";
import { TrackingController } from "../controllers/tracking-controller.ts";

// Fork registrations so concurrent requests never replace each other's repositories.
export function createControllers(accuracyService: AccuracyService) {
    const container = useContainer().fork();
    container.registerFactory(AccuracyService, () => accuracyService, { singleton: false });
    return {
        tracking: container.resolve(TrackingController),
        forecast: container.resolve(ForecastController),
    };
}

export function createAccuracyService(db: SqlDatabase): AccuracyService {
    const container = useContainer().fork();
    container.registerFactory(SQL_DATABASE, () => db, { singleton: false });
    return container.resolve(AccuracyService);
}
