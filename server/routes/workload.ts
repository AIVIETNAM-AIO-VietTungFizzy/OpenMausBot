import { ownerOrAdmin } from "../request-auth.ts";
import type { BackgroundJob, BackgroundJobs, JobStatus } from "../workload/background-jobs.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface WorkloadRouteDeps {
  snapshots(): unknown;
  ungoverned(): unknown[];
  jobs: BackgroundJobs | null;
  /** Cancels the job's own work (a routine run) so the ledger settles through it. */
  cancelJob(job: BackgroundJob): Promise<boolean>;
}

const STATUSES = new Set<JobStatus>(["queued", "running", "completed", "failed", "cancelled"]);
const CANCEL = /^\/api\/workload\/jobs\/([\w-]{1,80})\/cancel$/;
const JOB = /^\/api\/workload\/jobs\/([\w-]{1,80})$/;

/** Owner-only: queue depths, timings and job states; never a prompt or a reply. */
export function createWorkloadRoutes(deps: WorkloadRouteDeps): RouteHandler {
  return async ({ res, url, path, method, auth, json }) => {
    if (!path.startsWith("/api/workload")) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "forbidden" });
    res.setHeader("cache-control", "no-store");
    if (method === "GET" && path === "/api/workload") {
      return json(res, 200, {
        ...(deps.snapshots() as Record<string, unknown>),
        ungoverned: deps.ungoverned(),
        backgroundJobs: deps.jobs ? { counts: deps.jobs.counts(), oldestQueuedAgeMs: deps.jobs.oldestQueuedAgeMs(), refusedFull: deps.jobs.refusedFull } : null,
      });
    }
    if (method === "GET" && path === "/api/workload/jobs") {
      if (!deps.jobs) return json(res, 200, { jobs: [] });
      const status = url.searchParams.get("status");
      if (status !== null && !STATUSES.has(status as JobStatus)) return json(res, 400, { error: "unknown status" });
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json(res, 200, { jobs: deps.jobs.list({ ...(status ? { status: status as JobStatus } : {}), limit: Number.isSafeInteger(limit) ? limit : 50 }) });
    }
    const one = JOB.exec(path);
    if (method === "GET" && one) {
      const job = deps.jobs?.get(one[1]!);
      return job ? json(res, 200, { job }) : json(res, 404, { error: "not found" });
    }
    const cancel = CANCEL.exec(path);
    if (method === "POST" && cancel) {
      const job = deps.jobs?.get(cancel[1]!);
      if (!job) return json(res, 404, { error: "not found" });
      if (job.status !== "queued" && job.status !== "running") return json(res, 409, { error: "already settled", job });
      const cancelled = await deps.cancelJob(job);
      return json(res, 200, { job: cancelled ? deps.jobs!.get(job.id) : deps.jobs!.cancel(job.id) });
    }
    return PASS;
  };
}
