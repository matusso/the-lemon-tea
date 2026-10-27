import {
  CreateJobInput,
  IngestInput,
  LemonTeaError,
  PredictQualifyingInput,
  PredictRaceResultInput,
  SimulateStrategyInput,
  type AuthContext,
  type Scope,
} from "@lemon-tea/shared-types";
import type { z } from "zod";
import type { AccessPolicy } from "./access.ts";
import type { JobRecord, Store } from "./store.ts";
import type { Services } from "./container.ts";

const JOB_SCOPES: Record<string, Scope> = {
  simulate_strategy: "simulations:execute",
  predict_race_result: "simulations:execute",
  predict_qualifying: "predictions:read",
  ingest_session: "ingest:write",
};

/** Per-tenant concurrency quota for queued/running jobs. */
export const MAX_ACTIVE_JOBS_PER_TENANT = 5;

function publicJob(j: JobRecord) {
  return {
    jobId: j.id,
    kind: j.kind,
    status: j.status,
    progress: j.progress,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error,
    resultAvailable: j.status === "succeeded",
    resultRef: j.status === "succeeded" ? `lemontea://analyses/${j.id}` : null,
  };
}

export class JobService {
  constructor(
    private readonly store: Store,
    private readonly access: AccessPolicy,
    /** Optional push notification (e.g. Cloudflare Queue); runners also poll, so this is an accelerator. */
    private readonly onCreated?: (jobId: string) => Promise<void>,
  ) {}

  async create(ctx: AuthContext, input: z.infer<typeof CreateJobInput>) {
    if (ctx.anonymous || !ctx.tenantId) throw new LemonTeaError("unauthorized", "Analysis jobs require an authenticated user");
    const scope = JOB_SCOPES[input.kind];
    if (!scope) throw new LemonTeaError("invalid_input", `Unknown job kind ${input.kind}`);
    this.access.require(ctx, scope);
    validateJobInput(input.kind, input.input);
    if (input.idempotencyKey) {
      const existing = await this.store.jobByIdempotencyKey(this.access.scope(ctx), input.idempotencyKey);
      if (existing) return { ...publicJob(existing), deduplicated: true };
    }
    const active = await this.store.countActiveJobs(this.access.scope(ctx));
    if (active >= MAX_ACTIVE_JOBS_PER_TENANT) {
      throw new LemonTeaError("quota_exceeded", `At most ${MAX_ACTIVE_JOBS_PER_TENANT} queued or running jobs per tenant`);
    }
    const { job, created } = await this.store.createJob(this.access.scope(ctx), {
      userId: ctx.userId,
      kind: input.kind,
      input: input.input,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    if (created) await this.onCreated?.(job.id);
    return { ...publicJob(job), deduplicated: !created };
  }

  async get(ctx: AuthContext, jobId: string) {
    if (ctx.anonymous) throw new LemonTeaError("unauthorized", "Authentication required");
    const j = await this.store.getJob(this.access.scope(ctx), jobId);
    if (!j || j.tenantId !== ctx.tenantId) throw new LemonTeaError("not_found", "Job not found");
    return publicJob(j);
  }

  async result(ctx: AuthContext, jobId: string) {
    if (ctx.anonymous) throw new LemonTeaError("unauthorized", "Authentication required");
    const j = await this.store.getJob(this.access.scope(ctx), jobId);
    if (!j || j.tenantId !== ctx.tenantId) throw new LemonTeaError("not_found", "Job not found");
    if (j.status !== "succeeded") throw new LemonTeaError("conflict", `Job is ${j.status}`, { status: j.status });
    return { jobId: j.id, kind: j.kind, result: j.result };
  }

  async cancel(ctx: AuthContext, jobId: string) {
    if (ctx.anonymous) throw new LemonTeaError("unauthorized", "Authentication required");
    const existing = await this.store.getJob(this.access.scope(ctx), jobId);
    if (!existing || existing.tenantId !== ctx.tenantId) throw new LemonTeaError("not_found", "Job not found");
    const j = await this.store.requestJobCancel(this.access.scope(ctx), jobId);
    return publicJob(j!);
  }

}

function validateJobInput(kind: string, input: unknown) {
  const schema = { simulate_strategy: SimulateStrategyInput, predict_race_result: PredictRaceResultInput, predict_qualifying: PredictQualifyingInput, ingest_session: IngestInput }[kind];
  if (!schema) return;
  const r = schema.safeParse(input);
  if (!r.success) throw new LemonTeaError("invalid_input", "Invalid job input", { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
}

/**
 * Executes one claimed job as the job's owner (re-derived from the stored user, never from the
 * job payload), using the same services as the interactive interfaces.
 */
export async function runJob(
  services: Services,
  job: JobRecord,
  ownerCtx: AuthContext,
  progress: (p: number) => Promise<void>,
  cancelled: () => Promise<boolean>,
): Promise<unknown> {
  switch (job.kind) {
    case "simulate_strategy":
      return services.strategy.simulate(ownerCtx, SimulateStrategyInput.parse(job.input));
    case "predict_race_result":
      return services.strategy.raceResult(ownerCtx, PredictRaceResultInput.parse(job.input));
    case "predict_qualifying":
      return services.qualifying.predict(ownerCtx, PredictQualifyingInput.parse(job.input));
    case "ingest_session": {
      if (!services.ingestion) throw new LemonTeaError("internal", "Ingestion is not configured in this worker");
      return services.ingestion.ingest(ownerCtx, IngestInput.parse(job.input), (p) => void progress(p.total ? p.done / p.total : 0), cancelled);
    }
    default:
      throw new LemonTeaError("invalid_input", `Unsupported job kind ${job.kind}`);
  }
}

