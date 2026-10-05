import { useContainer } from "@di-framework/core/container";
import { ForecastController } from "../forecast-endpoint.ts";
import { LEDGER } from "./accuracy-service.ts";
import { TrackingController } from "./controller.ts";
import { D1Ledger, type Ledger, type SqlDatabase, SQL_DATABASE } from "./ledger.ts";

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
