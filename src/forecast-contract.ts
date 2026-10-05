import type { Calibration, RoadmapEstimate } from "./estimator.ts";
import type { ForecastPlan } from "./forecast-plan.ts";
import type { HistoricalData } from "./history.ts";
import type { AccuracyReport, Observation, Prediction } from "./tracking/model.ts";

export type ForecastRequest = {
    repository: string;
    roadmap: {
        number: number;
        title: string;
        body: string;
        titles: Record<string, string>;
        states?: Record<string, string>;
    };
    history: HistoricalData;
    plan?: ForecastPlan;
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
    stored: number;
};

export type BacktestRequest = { repository: string; history: HistoricalData; record?: boolean };
export type BacktestResponse = {
    repository: string;
    predictions: Prediction[];
    observations: Observation[];
    reports: AccuracyReport[];
    stored: { predictions: number; observations: number };
};
