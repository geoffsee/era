import { SQL_DATABASE, type SqlDatabase } from "../persistence/database.ts";
import { useContainer } from "@di-framework/core/container";
import { ForecastController } from "../controllers/forecast-controller.ts";
import { LEDGER } from "../services/accuracy-service.ts";
import { TrackingController } from "../controllers/tracking-controller.ts";
import { D1Ledger, type Ledger } from "../repositories/ledger.ts";

// Fork registrations so concurrent requests never replace each other's repositories.
export function createControllers(ledger: Ledger) {
    const container = useContainer().fork();
    container.registerFactory(LEDGER, () => ledger, { singleton: false });
    return {
        tracking: container.resolve(TrackingController),
        forecast: container.resolve(ForecastController),
    };
}

export function createLedger(db: SqlDatabase): D1Ledger {
    const container = useContainer().fork();
    container.registerFactory(SQL_DATABASE, () => db, { singleton: false });
    return container.resolve(D1Ledger);
}
