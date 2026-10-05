import { ApplicationContext } from "@di-framework/core/application-context";
import { useContainer } from "@di-framework/core/container";
import { WORKER_SETTINGS, WorkerConfiguration, type WorkerSettings } from "./configuration.ts";
import { ForecastController } from "./controllers/forecast-controller.ts";
import { TrackingController } from "./controllers/tracking-controller.ts";
import router from "./http.ts";
import { AuthRepository } from "./repositories/auth-repository.ts";

const container = useContainer();

// Bindings become beans and the always-on controllers resolve before the first request,
// so a missing registration fails at deploy time rather than under traffic.
await ApplicationContext.builder(container)
    .configuration(WorkerConfiguration)
    .bootstrap(ForecastController, TrackingController)
    .start();

export default {
    fetch: (request: Request): Promise<Response> => router.fetch(request),
    async scheduled(): Promise<void> {
        if (container.resolve<WorkerSettings>(WORKER_SETTINGS).auth) await container.resolve(AuthRepository).purge();
    },
};
