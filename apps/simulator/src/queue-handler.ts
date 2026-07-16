export interface ForecastQueueMessageBody {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
}

export class PermanentForecastMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentForecastMessageError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function forecastQueueMessage(value: unknown): ForecastQueueMessageBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PermanentForecastMessageError("Forecast Queue message must be an object");
  }
  const entries = Object.entries(value);
  const allowed = new Set(["tenantId", "projectId", "runId"]);
  if (entries.length !== allowed.size || entries.some(([key]) => !allowed.has(key))) {
    throw new PermanentForecastMessageError("Forecast Queue message fields are invalid");
  }
  const body = value as Record<string, unknown>;
  for (const field of allowed) {
    if (typeof body[field] !== "string" || !UUID.test(body[field])) {
      throw new PermanentForecastMessageError(`Forecast Queue ${field} must be a UUID`);
    }
  }
  return {
    tenantId: body.tenantId as string,
    projectId: body.projectId as string,
    runId: body.runId as string,
  };
}

export function forecastRetryDelaySeconds(attempts: number): number {
  const normalized = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
  return Math.min(30 * (2 ** (normalized - 1)), 43_200);
}

export async function handleForecastBatch(
  batch: MessageBatch<unknown>,
  process: (body: ForecastQueueMessageBody) => Promise<void>,
  options?: {
    readonly maxDeliveryAttempts: number;
    readonly onRetriesExhausted: (body: ForecastQueueMessageBody, error: unknown) => Promise<void>;
  },
): Promise<void> {
  for (const message of batch.messages) {
    let body: ForecastQueueMessageBody | undefined;
    try {
      body = forecastQueueMessage(message.body);
      await process(body);
      message.ack();
    } catch (error) {
      if (error instanceof PermanentForecastMessageError) {
        console.error(JSON.stringify({
          event: "forecast_message_rejected",
          messageId: message.id,
          error: error.message,
        }));
        message.ack();
      } else if (body !== undefined && options !== undefined && message.attempts >= options.maxDeliveryAttempts) {
        try {
          await options.onRetriesExhausted(body, error);
          message.ack();
        } catch (finalizationError) {
          console.error(JSON.stringify({
            event: "forecast_exhaustion_finalization_retry",
            messageId: message.id,
            attempts: message.attempts,
            error: finalizationError instanceof Error ? finalizationError.message : "Unknown finalization failure",
          }));
          message.retry({ delaySeconds: forecastRetryDelaySeconds(message.attempts) });
        }
      } else {
        console.error(JSON.stringify({
          event: "forecast_message_retry",
          messageId: message.id,
          attempts: message.attempts,
          error: error instanceof Error ? error.message : "Unknown transient failure",
        }));
        message.retry({ delaySeconds: forecastRetryDelaySeconds(message.attempts) });
      }
    }
  }
}
