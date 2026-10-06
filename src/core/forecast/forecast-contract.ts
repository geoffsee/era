import type { Calibration, RoadmapEstimate } from "./estimator.ts";
import type { ForecastPlan } from "./forecast-plan.ts";
import type { InferenceConfig, InferredEstimates } from "./inference.ts";
import type { HistoricalData } from "../history/history.ts";
import type { RoadmapConfig } from "../roadmap/roadmap-format.ts";
import type { AccuracyReport, Observation, Prediction } from "../tracking/model.ts";

export type ForecastRequest = {
    repository: string;
    roadmap: {
        number: number;
        title: string;
        body: string;
        titles?: Record<string, string>;
        states?: Record<string, string>;
        /** Child issue bodies for in-context inference; the Worker truncates each one. */
        descriptions?: Record<string, string>;
    };
    history: HistoricalData;
    roadmapConfig?: RoadmapConfig;
    plan?: ForecastPlan;
    /** Additional per-item estimates for the Worker's model to infer in context. */
    inference?: InferenceConfig;
    record?: boolean;
};

type CalibrationMaps = "labels" | "epicTokens" | "epicPoints" | "epicReviewRatio" | "epicReviewCicdSeconds";
export type JsonEstimate = Omit<RoadmapEstimate, "calibration"> & {
    calibration: Omit<Calibration, CalibrationMaps> & Record<CalibrationMaps, Record<string, number>>;
};

export type ForecastResponse = {
    repository: string;
    estimate: JsonEstimate;
    report: string;
    predictions: Prediction[];
    /** Present when the request configured inference fields. */
    inferred?: InferredEstimates;
    stored: number;
};

export type BacktestRequest = {
    repository: string;
    history: HistoricalData;
    record?: boolean;
    roadmapConfig?: RoadmapConfig;
};
export type BacktestResponse = {
    repository: string;
    predictions: Prediction[];
    observations: Observation[];
    reports: AccuracyReport[];
    stored: { predictions: number; observations: number };
};
