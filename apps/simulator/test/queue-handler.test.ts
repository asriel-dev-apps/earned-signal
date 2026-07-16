import { describe, expect, it, vi } from "vitest";
import {
  PermanentForecastMessageError,
  forecastQueueMessage,
  forecastRetryDelaySeconds,
  handleForecastBatch,
} from "../src/queue-handler.js";

const body = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000001",
  runId: "30000000-0000-4000-8000-000000000001",
};

function message(value: unknown, attempts = 1) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body: value,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function batch(messages: readonly ReturnType<typeof message>[]) {
  return {
    queue: "earned-signal-forecast-runs",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

describe("Forecast Queue boundary", () => {
  it("accepts only the three UUID routing fields", () => {
    expect(forecastQueueMessage(body)).toEqual(body);
    expect(() => forecastQueueMessage({ ...body, input: {} })).toThrow(PermanentForecastMessageError);
    expect(() => forecastQueueMessage({ ...body, runId: "run-1" })).toThrow("runId must be a UUID");
  });

  it("acks each successful message independently", async () => {
    const first = message(body);
    const second = message({ ...body, runId: "30000000-0000-4000-8000-000000000002" });
    const process = vi.fn(async () => undefined);

    await handleForecastBatch(batch([first, second]), process);

    expect(process).toHaveBeenCalledTimes(2);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
  });

  it("acks permanent failures and retries only the transient message", async () => {
    const invalid = message({ ...body, unexpected: true });
    const transient = message(body, 3);

    await handleForecastBatch(batch([invalid, transient]), async () => {
      throw new Error("Postgres is temporarily unavailable");
    });

    expect(invalid.ack).toHaveBeenCalledOnce();
    expect(invalid.retry).not.toHaveBeenCalled();
    expect(transient.ack).not.toHaveBeenCalled();
    expect(transient.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
  });

  it("uses bounded exponential backoff", () => {
    expect(forecastRetryDelaySeconds(1)).toBe(30);
    expect(forecastRetryDelaySeconds(4)).toBe(240);
    expect(forecastRetryDelaySeconds(100)).toBe(43_200);
  });

  it("terminalizes a valid message after its configured final delivery attempt", async () => {
    const finalDelivery = message(body, 6);
    const onRetriesExhausted = vi.fn(async () => undefined);

    await handleForecastBatch(batch([finalDelivery]), async () => {
      throw new Error("Simulator remained unavailable");
    }, { maxDeliveryAttempts: 6, onRetriesExhausted });

    expect(onRetriesExhausted).toHaveBeenCalledWith(body, expect.any(Error));
    expect(finalDelivery.ack).toHaveBeenCalledOnce();
    expect(finalDelivery.retry).not.toHaveBeenCalled();
  });

  it("retries the final delivery when terminalization itself is unavailable", async () => {
    const finalDelivery = message(body, 6);
    await handleForecastBatch(batch([finalDelivery]), async () => {
      throw new Error("Simulator remained unavailable");
    }, {
      maxDeliveryAttempts: 6,
      onRetriesExhausted: async () => { throw new Error("Postgres remained unavailable"); },
    });

    expect(finalDelivery.ack).not.toHaveBeenCalled();
    expect(finalDelivery.retry).toHaveBeenCalledOnce();
  });
});
