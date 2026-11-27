import type { TextGenerationOptions, TurnWorkload } from "../contracts.ts";
import type { SideJob } from "../side-jobs.ts";

/** A turn is interactive when it is a person's own work by the same rule engine memory uses to let it go first. */
export function turnWorkload(personsOwnWork: boolean, botId: string, threadId: string): TurnWorkload {
  return personsOwnWork
    ? { workloadClass: "interactive", source: "person-turn", botId, threadId }
    : { workloadClass: "background", source: "automatic-turn", botId, threadId };
}

const WAITED_ON: Record<SideJob, boolean> = {
  compaction: true,
  "setup-suggestions": true,
  memory: false,
  "skill-review": false,
  representative: false,
  "status-reply": false,
  // A person reads its summary through a 10 s route.
  "skill-burger": true,
  // The composer's next-line suggestion, shown while the person types.
  "suggested-reply": true,
};

export function sideJobWorkload(job: SideJob, botId: string): TurnWorkload {
  return { workloadClass: WAITED_ON[job] ? "interactive" : "background", source: "helper", botId, taskId: job };
}

type TextCall = (prompt: string, options?: TextGenerationOptions) => Promise<string>;

/** The classification is the caller's own: whatever options arrive, this call keeps it. */
export function classifiedCall(call: TextCall, workload: TurnWorkload): TextCall {
  return (prompt, options) => call(prompt, { ...options, workload });
}
