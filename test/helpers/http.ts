import { ApplicationContext } from "@di-framework/core/application-context";
import { type Container, useContainer } from "@di-framework/core/container";
import {
    SQL_DATABASE,
    WORKER_SETTINGS,
    WorkerConfiguration,
    type WorkerSettings,
} from "../../src/app/configuration.ts";
import { AuthController } from "../../src/app/controllers/auth-controller.ts";
import { ForecastController } from "../../src/app/controllers/forecast-controller.ts";
import { TrackingController } from "../../src/app/controllers/tracking-controller.ts";
import worker from "../../src/app/main.ts";
import { AuthRepository } from "../../src/app/repositories/auth-repository.ts";
import { ForecastSchema } from "../../src/app/repositories/forecast-schema.ts";
import { ObservationRepository } from "../../src/app/repositories/observation-repository.ts";
import { PredictionRepository } from "../../src/app/repositories/prediction-repository.ts";
import { AccuracyService } from "../../src/app/services/accuracy-service.ts";
import { AuthService } from "../../src/app/services/auth-service.ts";
import { ForecastService } from "../../src/app/services/forecast-application-service.ts";
import { env, oidc } from "../cloudflare.ts";

export type TrackerDeps = {
    accuracyService: AccuracyService;
    apiToken: string;
    audience?: string;
    auth?: AuthService;
    verifyOidc?: CredentialVerifier;
};
type CredentialVerifier = (token: string, audience: string) => Promise<{ repository: string; workflowRef?: string }>;

/** Every decorated component of the Worker graph. Re-registering drops singletons built for an earlier fixture. */
const WORKER_GRAPH: ReadonlyArray<Parameters<Container["register"]>[0]> = [
    ForecastSchema,
    AuthRepository,
    PredictionRepository,
    ObservationRepository,
    AccuracyService,
    ForecastService,
    AuthService,
    AuthController,
    ForecastController,
    TrackingController,
];

/** Send one request through the production Worker with this fixture's collaborators bound on the container. */
export function handleRequest(request: Request, deps: TrackerDeps): Promise<Response> {
    const container = useContainer();
    for (const component of WORKER_GRAPH) container.register(component);
    container.registerValue(SQL_DATABASE, env.DB);
    container.registerValue<WorkerSettings>(WORKER_SETTINGS, {
        apiToken: deps.apiToken,
        oidcAudience: deps.audience,
        auth: deps.auth?.config,
    });
    container.registerValue(AccuracyService, deps.accuracyService);
    container.registerValue(AuthService, deps.auth);
    oidc.verify = deps.verifyOidc;
    return worker.fetch(request);
}

/** Rebuild the production graph from the fake bindings, exactly as the Worker does at startup. */
export async function startWorker(): Promise<void> {
    const container = useContainer();
    container.clear();
    for (const component of WORKER_GRAPH) container.register(component);
    oidc.verify = undefined;
    await ApplicationContext.builder(container)
        .configuration(WorkerConfiguration)
        .bootstrap(ForecastController, TrackingController)
        .start();
}
