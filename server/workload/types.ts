export type WorkloadClass = "interactive" | "background";

/** What started the work. Only server code that starts a turn or a helper call sets it; no request body can. */
export type WorkloadSource =
  | "person-turn"
  | "automatic-turn"
  | "helper"
  | "background-job"
  | "setup-check"
  | "unclassified";
