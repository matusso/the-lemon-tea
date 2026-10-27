import { userContext, type IdentityStore } from "@lemon-tea/auth";
import { runJob, type JobRecord, type Services } from "@lemon-tea/domain";
import { LemonTeaError } from "@lemon-tea/shared-types";

/**
 * Execute one claimed job. The acting identity is re-derived from the job's stored user id,
 * so a job can never run with more rights than its creator currently has.
 */
export async function processJob(services: Services, identity: IdentityStore, job: JobRecord, log = console.log): Promise<void> {
  const store = services.store;
  try {
    if (!job.userId) throw new LemonTeaError("forbidden", "Job has no owner");
    const user = await identity.userById(job.userId);
    if (!user || user.tenantId !== job.tenantId) throw new LemonTeaError("forbidden", "Job owner no longer exists");
    const ctx = userContext(user, "system");
    const cancelled = async () => (await store.getJob({ tenantId: job.tenantId }, job.id))?.cancelRequested ?? false;
    const result = await runJob(services, job, ctx, async (p) => void (await store.updateJob(job.id, { progress: p })), cancelled);
    if (await cancelled()) {
      await store.updateJob(job.id, { status: "cancelled" });
      return;
    }
    await store.updateJob(job.id, { status: "succeeded", progress: 1, result });
    log(`[jobs] ${job.kind} ${job.id} succeeded`);
  } catch (e) {
    const err = e instanceof LemonTeaError ? e.toJSON().error : { code: "internal", message: "Job failed" };
    if (!(e instanceof LemonTeaError)) log(`[jobs] ${job.kind} ${job.id} failed: ${(e as Error).message}`);
    await store.updateJob(job.id, { status: err.code === "conflict" && /cancel/i.test(err.message) ? "cancelled" : "failed", error: err });
  }
}
