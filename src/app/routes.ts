import { json } from "@di-framework/http/portable";
import { AuthController } from "./controllers/auth-controller.ts";
import { ForecastController } from "./controllers/forecast-controller.ts";
import { TrackingController } from "./controllers/tracking-controller.ts";
import { router } from "./http.ts";

// Importing the controllers runs their static @Endpoint fields, which register routes.
void AuthController;
void ForecastController;
void TrackingController;

router.all("*", () => json({ error: "not found" }, { status: 404 }));

export default router;
