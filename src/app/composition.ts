import { FORECAST_REPOSITORY } from "../repositories/forecast-repository.ts";
import { SQL_DATABASE, type SqlDatabase } from "../persistence/database.ts";
import { useContainer } from "@di-framework/core/container";
import { ForecastController } from "../controllers/forecast-controller.ts";
import { TrackingController } from "../controllers/tracking-controller.ts";
import { SqliteForecastRepository, type ForecastRepository } from "../repositories/forecast-repository.ts";

// Fork registrations so concurrent requests never replace each other's repositories.
export function createControllers(forecastRepository: ForecastRepository) {
    const container = useContainer().fork();
    container.registerFactory(FORECAST_REPOSITORY, () => forecastRepository, { singleton: false });
    return {
        tracking: container.resolve(TrackingController),
        forecast: container.resolve(ForecastController),
    };
}

export function createForecastRepository(db: SqlDatabase): SqliteForecastRepository {
    const container = useContainer().fork();
    container.registerFactory(SQL_DATABASE, () => db, { singleton: false });
    return container.resolve(SqliteForecastRepository);
}
