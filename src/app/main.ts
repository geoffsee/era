import { env } from "cloudflare:workers";
import { bindCloudflareBindings } from "@di-framework/cloudflare";
import { ApplicationContext } from "@di-framework/core/application-context";
import { useContainer } from "@di-framework/core/container";
import {
    CLOUDFLARE_BINDING_OPTIONS,
    WORKER_SETTINGS,
    WorkerConfiguration,
    type WorkerSettings,
} from "./configuration.ts";
import { ForecastController } from "./controllers/forecast-controller.ts";
import { TrackingController } from "./controllers/tracking-controller.ts";
import router from "./http.ts";
import { AuthRepository } from "./repositories/auth-repository.ts";

const container = useContainer();

// The connector publishes the Worker bindings and registers lazy factories for them; the configuration
// turns them into beans and the always-on controllers resolve before the first request, so a missing
// registration fails at deploy time rather than under traffic.
bindCloudflareBindings(container, { ...CLOUDFLARE_BINDING_OPTIONS, bindings: env });
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
