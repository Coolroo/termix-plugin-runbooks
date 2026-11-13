/**
 * What an audit line is about. Core's audit log keeps a resource's name
 * short: a title is cut to 200 characters.
 */

/** A step as an audit line names it. */
export function stepResource(step: { id: number; title: string }) {
  return {
    resourceType: "runbooks_step",
    resourceId: String(step.id),
    resourceName: step.title.slice(0, 200),
  };
}

/** A runbook as an audit line names it. */
export function runbookResource(runbook: { id: number; title: string }) {
  return {
    resourceType: "runbooks_runbook",
    resourceId: String(runbook.id),
    resourceName: runbook.title.slice(0, 200),
  };
}
