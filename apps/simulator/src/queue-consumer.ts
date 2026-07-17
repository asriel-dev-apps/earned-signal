import { ForecastValidationError } from "@earned-signal/application";
import {
  createPersistenceDatabase,
  ForecastRunNotFoundError,
  ForecastRunStaleError,
  ProjectForecastRunRepository,
  type ForecastActor,
  type ForecastRun,
} from "@earned-signal/persistence";
import { Client } from "pg";
import { ZodError } from "zod";
import { handleForecastBatch, PermanentForecastMessageError, type ForecastQueueMessageBody } from "./queue-handler.js";
import { callForecastSimulator, ForecastSimulatorHttpError, parseForecastProblem } from "./solver-contract.js";

const SYSTEM_ACTOR: ForecastActor = { type: "SYSTEM", id: "forecast-simulator" };
const MAX_DELIVERY_ATTEMPTS = 6;

export function forecastQueueKind(
  queue: string,
  expectedQueue: string,
  expectedDlq: string,
): "PRIMARY" | "DLQ" {
  if (expectedQueue.length === 0 || expectedDlq.length === 0 || expectedQueue === expectedDlq) {
    throw new Error("Forecast Queue configuration is invalid");
  }
  if (queue === expectedQueue) return "PRIMARY";
  if (queue === expectedDlq) return "DLQ";
  throw new Error(`Unexpected Forecast Queue ${queue}`);
}

interface ForecastRunStore {
  load(tenantId: string, projectId: string, scenarioId: string, forecastRunId: string): Promise<ForecastRun | null>;
  markRunning(request: { readonly tenantId: string; readonly projectId: string; readonly scenarioId: string; readonly forecastRunId: string; readonly actor: ForecastActor }): Promise<ForecastRun>;
  complete(request: { readonly tenantId: string; readonly projectId: string; readonly scenarioId: string; readonly forecastRunId: string; readonly status: "READY" | "FAILED"; readonly algorithmVersion: string; readonly output: unknown; readonly actor: ForecastActor }): Promise<unknown>;
}

interface ForecastProcessorPorts {
  readonly scenarioId: (body: ForecastQueueMessageBody) => Promise<string | null>;
  readonly runs: ForecastRunStore;
  readonly simulate: (run: ForecastRun) => Promise<unknown>;
}

function failure(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof ForecastRunStaleError) return { code: "FORECAST_SOURCE_STALE", message: error.message };
  if (error instanceof ForecastSimulatorHttpError) return { code: "SIMULATOR_REQUEST_REJECTED", message: error.message };
  if (error instanceof ForecastValidationError || error instanceof ZodError) return { code: "SIMULATOR_RESULT_INVALID", message: error.message };
  return { code: "SIMULATION_FAILED", message: error instanceof Error ? error.message : "Forecast simulation failed" };
}

function permanent(error: unknown): boolean {
  return error instanceof ForecastValidationError || error instanceof ZodError || error instanceof ForecastRunStaleError ||
    error instanceof ForecastRunNotFoundError ||
    (error instanceof ForecastSimulatorHttpError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429);
}

export function createForecastMessageProcessor(ports: ForecastProcessorPorts) {
  return async (body: ForecastQueueMessageBody): Promise<void> => {
    const scenarioId = await ports.scenarioId(body);
    if (scenarioId === null) throw new PermanentForecastMessageError("Forecast Run routing record was not found");
    const identity = { ...body, scenarioId, forecastRunId: body.runId };
    const existing = await ports.runs.load(body.tenantId, body.projectId, scenarioId, body.runId);
    if (existing === null) throw new PermanentForecastMessageError("Forecast Run was not found");
    if (existing.status === "READY" || existing.status === "FAILED") return;
    try {
      const running = await ports.runs.markRunning({ ...identity, actor: SYSTEM_ACTOR });
      if (running.status === "READY" || running.status === "FAILED") return;
      const output = await ports.simulate(running);
      await ports.runs.complete({
        ...identity,
        status: "READY",
        algorithmVersion: "earned-signal-monte-carlo-1",
        output,
        actor: SYSTEM_ACTOR,
      });
    } catch (error) {
      if (!permanent(error)) throw error;
      const output = failure(error);
      await ports.runs.complete({
        ...identity,
        status: "FAILED",
        algorithmVersion: "earned-signal-monte-carlo-1",
        output,
        actor: SYSTEM_ACTOR,
      });
    }
  };
}

export function createForecastExhaustionProcessor(ports: Pick<ForecastProcessorPorts, "scenarioId" | "runs">) {
  return async (body: ForecastQueueMessageBody): Promise<void> => {
    const scenarioId = await ports.scenarioId(body);
    if (scenarioId === null) throw new PermanentForecastMessageError("Forecast Run routing record was not found");
    const existing = await ports.runs.load(body.tenantId, body.projectId, scenarioId, body.runId);
    if (existing === null) throw new PermanentForecastMessageError("Forecast Run was not found");
    if (existing.status === "READY" || existing.status === "FAILED") return;
    await ports.runs.complete({
      ...body,
      scenarioId,
      forecastRunId: body.runId,
      status: "FAILED",
      algorithmVersion: "earned-signal-monte-carlo-1",
      output: { code: "FORECAST_RETRIES_EXHAUSTED", message: "Forecast simulation retries were exhausted" },
      actor: SYSTEM_ACTOR,
    });
  };
}

export async function processForecastBatch(batch: MessageBatch<unknown>, environment: Env): Promise<void> {
  const queueKind = forecastQueueKind(
    batch.queue,
    environment.EXPECTED_FORECAST_QUEUE,
    environment.EXPECTED_FORECAST_DLQ,
  );
  const client = new Client({ connectionString: environment.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    const runs = new ProjectForecastRunRepository(createPersistenceDatabase(client));
    const scenarioId = async (body: ForecastQueueMessageBody) => {
      const result = await client.query<{ scenario_id: string }>({
        text: "select scenario_id from forecast_runs where tenant_id = $1 and project_id = $2 and id = $3 limit 1",
        values: [body.tenantId, body.projectId, body.runId],
      });
      return result.rows[0]?.scenario_id ?? null;
    };
    const exhaust = createForecastExhaustionProcessor({ runs, scenarioId });
    if (queueKind === "DLQ") {
      await handleForecastBatch(batch, exhaust);
      return;
    }
    const process = createForecastMessageProcessor({
      runs,
      scenarioId,
      simulate: async (run) => {
        const problem = parseForecastProblem(run.input);
        const container = environment.FORECAST_SIMULATOR.getByName(run.id);
        await container.startAndWaitForPorts();
        return callForecastSimulator(problem, run.requestHash, (request) => container.fetch(request));
      },
    });
    await handleForecastBatch(batch, process, {
      maxDeliveryAttempts: MAX_DELIVERY_ATTEMPTS,
      onRetriesExhausted: exhaust,
    });
  } finally {
    await client.end();
  }
}
