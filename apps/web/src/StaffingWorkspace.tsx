import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ProjectResource,
  ProjectState,
  ScenarioPlanCommand,
  StaffingObjectiveKind,
  StaffingProposalSolution,
} from "@earned-signal/application";
import { STAFFING_OBJECTIVE_PRIORITIES } from "@earned-signal/application";
import type {
  ProjectApiClient,
  StaffingProposalCreateInput,
  StaffingProposalDocument,
} from "./project-api-client.js";

const money = (value: number) => new Intl.NumberFormat("ja-JP", {
  style: "currency", currency: "JPY", maximumFractionDigits: 0,
}).format(value);
const hours = (minutes: number) => `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)} h`;
const objectiveLabels: Readonly<Record<StaffingObjectiveKind, string>> = {
  MINIMIZE_FINISH: "Earliest finish",
  MINIMIZE_COST: "Lowest planned labor cost",
  MINIMIZE_OVERTIME: "Least overtime",
  MINIMIZE_CHANGE: "Fewest plan changes",
};

interface EffortDraft {
  readonly minutes: string;
  readonly maxParallelResources: string;
  readonly confirmed: boolean;
}

interface CandidateDraft {
  readonly name: string;
  readonly calendarId: string;
  readonly dailyCapacityMinutes: string;
  readonly costRateMinorPerHour: string;
  readonly skillId: string;
}

function effortSuggestion(project: ProjectState, taskId: string): number {
  const task = project.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) return 0;
  const dailyAssignedMinutes = project.assignments
    .filter((assignment) => assignment.taskId === taskId)
    .reduce((total, assignment) => {
      const resource = project.resources.find((candidate) => candidate.id === assignment.resourceId);
      return total + (resource?.dailyCapacityMinutes ?? 480) * assignment.unitsPercent / 100;
    }, 0);
  return Math.max(1, Math.round(task.durationWorkingDays * (dailyAssignedMinutes || 480)));
}

function effortDrafts(project: ProjectState): Readonly<Record<string, EffortDraft>> {
  return Object.fromEntries(project.tasks.filter((task) => task.progressPercent < 100).map((task) => [
    task.id,
    { minutes: String(effortSuggestion(project, task.id)), maxParallelResources: "2", confirmed: false },
  ]));
}

function nullableNonNegative(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function valueLabel(value: unknown): string {
  if (value === null) return "None";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function describeChange(change: ScenarioPlanCommand, project: ProjectState, plan: ProjectState): string {
  if (change.type === "resource.add") {
    return `Add Resource · ${change.resource.name} · ${hours(change.resource.dailyCapacityMinutes)}/day · ${money(change.resource.costRateMinorPerHour)}/h · Skills ${change.resource.skillIds.join(", ") || "none"}`;
  }
  if (change.type === "assignment.replace") {
    const task = project.tasks.find((candidate) => candidate.id === change.taskId);
    const assignments = change.assignments.map((assignment) => {
      const resource = plan.resources.find((candidate) => candidate.id === assignment.resourceId);
      return `${resource?.name ?? assignment.resourceId} ${assignment.unitsPercent}%`;
    });
    return `Replace Assignments · ${task?.wbs ?? change.taskId} ${task?.name ?? "Unknown Task"} → ${assignments.join(", ") || "none"}`;
  }
  if (change.type === "task.update") {
    const task = project.tasks.find((candidate) => candidate.id === change.taskId);
    return Object.entries(change.changes).map(([field, next]) =>
      `${task?.wbs ?? change.taskId} ${task?.name ?? "Unknown Task"} · ${field}: ${valueLabel(task?.[field as keyof typeof task])} → ${valueLabel(next)}`,
    ).join(" · ");
  }
  return `${change.type} · ${valueLabel(change)}`;
}

function statusDetail(proposal: StaffingProposalDocument): string {
  if (proposal.status === "REQUESTED") return "Queued for deterministic optimization";
  if (proposal.status === "RUNNING") return "Solver and independent verification are running";
  if (proposal.status === "READY") return "Verified candidate · human review required";
  if (proposal.status === "INFEASIBLE") return "The submitted constraints could not be satisfied together";
  if (proposal.status === "UNKNOWN") return "No verified solution was produced within the run limit";
  return "The proposal run failed without changing Current";
}

export function StaffingWorkspace({
  project,
  projectRevision,
  suggestedDeadline,
  client,
  onOpenScenario,
}: {
  readonly project: ProjectState;
  readonly projectRevision: string | null;
  readonly suggestedDeadline: string;
  readonly client: ProjectApiClient | undefined;
  readonly onOpenScenario: (scenarioId: string) => void;
}) {
  const unfinished = useMemo(() => project.tasks.filter((task) => task.progressPercent < 100), [project.tasks]);
  const [efforts, setEfforts] = useState<Readonly<Record<string, EffortDraft>>>(() => effortDrafts(project));
  const [proposals, setProposals] = useState<readonly StaffingProposalDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">(client === undefined ? "loaded" : "loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState("Staffing recovery proposal");
  const [deadline, setDeadline] = useState(suggestedDeadline);
  const [costCap, setCostCap] = useState("");
  const [overtimeCap, setOvertimeCap] = useState("0");
  const [assignmentCap, setAssignmentCap] = useState(String(unfinished.length * 2));
  const [scheduleCap, setScheduleCap] = useState(String(unfinished.length));
  const [candidateCap, setCandidateCap] = useState("0");
  const priorities: readonly StaffingObjectiveKind[] = STAFFING_OBJECTIVE_PRIORITIES;
  const [candidates, setCandidates] = useState<readonly ProjectResource[]>([]);
  const [candidate, setCandidate] = useState<CandidateDraft>({
    name: "", calendarId: project.defaultCalendarId, dailyCapacityMinutes: "480",
    costRateMinorPerHour: "", skillId: "",
  });
  const selected = proposals.find((proposal) => proposal.id === selectedId) ?? null;
  const output = selected?.latestRun?.output ?? null;
  const solution = output !== null && (output.status === "OPTIMAL" || output.status === "FEASIBLE")
    ? output as StaffingProposalSolution
    : null;

  useEffect(() => setEfforts(effortDrafts(project)), [project]);

  const refresh = useCallback(async () => {
    if (client === undefined) return;
    setLoadState("loading");
    const loaded = await client.staffingProposals();
    setProposals(loaded);
    setSelectedId((current) => current !== null && loaded.some((proposal) => proposal.id === current)
      ? current
      : loaded[0]?.id ?? null);
    setLoadState("loaded");
  }, [client]);

  const refreshOne = useCallback(async (proposalId: string) => {
    if (client === undefined) return;
    const loaded = await client.loadStaffingProposal(proposalId);
    setProposals((items) => items.some((item) => item.id === loaded.id)
      ? items.map((item) => item.id === loaded.id ? loaded : item)
      : [loaded, ...items]);
  }, [client]);

  useEffect(() => {
    if (client === undefined) return;
    refresh().catch((error: unknown) => {
      setLoadState("error");
      setMessage(error instanceof Error ? error.message : "Staffing Proposals could not be loaded");
    });
  }, [client, refresh]);

  useEffect(() => {
    if (selected === null || (selected.status !== "REQUESTED" && selected.status !== "RUNNING")) return;
    const timer = window.setInterval(() => {
      refreshOne(selected.id).catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "Staffing Proposal status could not be refreshed");
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [refreshOne, selected]);

  if (client === undefined) {
    return <section className="staffing-unavailable" aria-label="Staffing Proposals unavailable">
      <span className="section-kicker">PERSISTED OPTIMIZATION</span>
      <h2>Staffing Proposals require a connected project</h2>
      <p>The demo does not run an optimizer or pretend that suggestions are persisted. Connect an authorized project to submit confirmed remaining effort and review solver-backed proposals.</p>
    </section>;
  }

  const allConfirmed = unfinished.length > 0 && unfinished.every((task) => {
    const draft = efforts[task.id];
    const minutes = Number(draft?.minutes);
    const parallel = Number(draft?.maxParallelResources);
    return draft?.confirmed === true && Number.isSafeInteger(minutes) && minutes > 0 && Number.isInteger(parallel) && parallel >= 1 && parallel <= 10;
  });
  const canSubmit = loadState === "loaded" && !busy && projectRevision !== null && name.trim() !== "" && allConfirmed;

  const updateEffort = (taskId: string, update: Partial<EffortDraft>) => setEfforts((current) => ({
    ...current,
    [taskId]: { ...current[taskId]!, ...update },
  }));
  const addCandidate = () => {
    const dailyCapacityMinutes = Number(candidate.dailyCapacityMinutes);
    const costRateMinorPerHour = Number(candidate.costRateMinorPerHour);
    if (
      candidate.name.trim() === "" || !Number.isInteger(dailyCapacityMinutes) || dailyCapacityMinutes < 1 ||
      dailyCapacityMinutes > 1_440 || !Number.isSafeInteger(costRateMinorPerHour) || costRateMinorPerHour < 0
    ) return;
    const resource: ProjectResource = {
      id: crypto.randomUUID(),
      name: candidate.name.trim(),
      calendarId: candidate.calendarId,
      dailyCapacityMinutes,
      costRateMinorPerHour,
      skillIds: candidate.skillId === "" ? [] : [candidate.skillId],
    };
    setCandidates((items) => [...items, resource]);
    setCandidate((value) => ({ ...value, name: "", costRateMinorPerHour: "" }));
    setCandidateCap((value) => String(Math.max(Number(value) || 0, candidates.length + 1)));
  };

  const submit = async () => {
    if (!canSubmit || projectRevision === null) return;
    const input: StaffingProposalCreateInput = {
      name: name.trim(),
      expectedRevision: projectRevision,
      remainingEffort: unfinished.map((task) => ({
        taskId: task.id,
        remainingEffortMinutes: Number(efforts[task.id]!.minutes),
        maxParallelResources: Number(efforts[task.id]!.maxParallelResources),
        provenance: "HUMAN_CONFIRMED",
      })),
      candidateResources: candidates,
      constraints: {
        version: "staffing-constraints-v1",
        deadline: deadline === "" ? null : deadline,
        maxPlannedLaborCostMinor: nullableNonNegative(costCap),
        maxOvertimeMinutes: nullableNonNegative(overtimeCap),
        maxAssignmentChanges: nullableNonNegative(assignmentCap),
        maxScheduleChanges: nullableNonNegative(scheduleCap),
        maxCandidateResources: Math.max(0, Number(candidateCap) || 0),
        requireSkillCoverage: true,
      },
      objective: { version: "staffing-objective-v1", priorities },
    };
    setBusy(true); setMessage(null);
    try {
      const result = await client.requestStaffingProposal(input);
      setProposals((items) => [result.proposal, ...items.filter((item) => item.id !== result.proposal.id)]);
      setSelectedId(result.proposal.id);
      setMessage(result.replayed ? "The matching request was replayed safely." : "Proposal queued. Current was not changed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Staffing Proposal could not be requested");
    } finally {
      setBusy(false);
    }
  };

  const changeDescriptions = solution?.changes.map((change) => describeChange(change, project, solution.plan)) ?? [];
  const diagnostics = output?.diagnostics ?? [];

  return <section className="staffing-workspace">
    <header className="staffing-heading"><div><span className="section-kicker">CONSTRAINT-BASED PLANNING</span><h2>Staffing Proposals</h2><p>Numeric plans come from the solver and deterministic verification. Only a human-reviewed Scenario can update Current.</p></div><span className="scenario-safety">Proposal only · Current unchanged</span></header>
    {message === null ? null : <div className="notice" role="alert"><strong>Staffing status</strong><span>{message}</span><button onClick={() => setMessage(null)} aria-label="Dismiss">×</button></div>}
    {loadState === "error" ? <section className="scenario-load-state"><strong>Staffing Proposals could not be loaded</strong><p>Submitting is disabled until the authorized persisted list is available.</p><button className="primary-button" onClick={() => refresh().catch(() => undefined)}>Retry loading</button></section> : <div className="staffing-layout">
      <aside className="staffing-list"><div className="staffing-list-heading"><strong>Proposals</strong><span>{proposals.length}</span></div>{loadState === "loading" ? <p>Loading persisted proposals…</p> : proposals.length === 0 ? <p>No proposals yet. Confirm every unfinished Task before submitting.</p> : proposals.map((proposal) => <button key={proposal.id} className={proposal.id === selectedId ? "active" : ""} onClick={() => { setSelectedId(proposal.id); refreshOne(proposal.id).catch(() => undefined); }}><strong>{proposal.name}</strong><span>{proposal.status} · Current r{proposal.baseProjectRevision}</span></button>)}</aside>
      <div className="staffing-content">
        <section className="staffing-form-card"><header><div><span className="section-kicker">HUMAN-CONFIRMED INPUT</span><h3>Request a proposal</h3></div><input aria-label="Staffing Proposal name" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} /></header>
          <div className="staffing-effort-table"><div className="staffing-effort-header"><span>Work package</span><span>Remaining effort</span><span>Max parallel</span><span>Confirmation</span></div>{unfinished.map((task) => { const draft = efforts[task.id]!; const suggestion = effortSuggestion(project, task.id); return <div className="staffing-effort-row" key={task.id}><span><strong>{task.wbs} · {task.name}</strong><small>Suggestion {hours(suggestion)} from Current duration and Assignments</small></span><label><input aria-label={`${task.name} remaining effort hours`} type="number" min="1" step="0.5" value={Number(draft.minutes) / 60} onChange={(event) => updateEffort(task.id, { minutes: String(Math.round(Number(event.target.value) * 60)), confirmed: false })} /> h</label><label><input aria-label={`${task.name} max parallel Resources`} type="number" min="1" max="10" value={draft.maxParallelResources} onChange={(event) => updateEffort(task.id, { maxParallelResources: event.target.value, confirmed: false })} /></label><label className="staffing-confirm"><input aria-label={`Confirm ${task.name} remaining effort`} type="checkbox" checked={draft.confirmed} onChange={(event) => updateEffort(task.id, { confirmed: event.target.checked })} /> HUMAN_CONFIRMED</label></div>; })}</div>
          <div className="staffing-constraints"><label>Deadline<input aria-label="Staffing deadline" type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label><label>Cost ceiling (JPY)<input aria-label="Staffing cost ceiling" type="number" min="0" placeholder="No ceiling" value={costCap} onChange={(event) => setCostCap(event.target.value)} /></label><label>Overtime ceiling (min)<input aria-label="Staffing overtime ceiling" type="number" min="0" value={overtimeCap} onChange={(event) => setOvertimeCap(event.target.value)} /></label><label>Assignment pair change cap<input aria-label="Staffing Assignment pair change cap" type="number" min="0" value={assignmentCap} onChange={(event) => setAssignmentCap(event.target.value)} /></label><label>Schedule change cap<input aria-label="Staffing schedule change cap" type="number" min="0" value={scheduleCap} onChange={(event) => setScheduleCap(event.target.value)} /></label><label>Candidate Resource cap<input aria-label="Staffing candidate Resource cap" type="number" min="0" max="100" value={candidateCap} onChange={(event) => setCandidateCap(event.target.value)} /></label></div>
          <div className="staffing-form-split"><section><h4>Fixed objective priority</h4><ol className="staffing-objectives">{priorities.map((priority, index) => <li key={priority}><span>{index + 1}</span><strong>{objectiveLabels[priority]}</strong></li>)}</ol></section><section className="staffing-candidates"><h4>Optional candidate Resource</h4><div><input aria-label="Candidate Resource name" placeholder="Name" value={candidate.name} onChange={(event) => setCandidate((value) => ({ ...value, name: event.target.value }))} /><select aria-label="Candidate Resource calendar" value={candidate.calendarId} onChange={(event) => setCandidate((value) => ({ ...value, calendarId: event.target.value }))}>{project.calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select><input aria-label="Candidate Resource daily minutes" type="number" min="1" max="1440" value={candidate.dailyCapacityMinutes} onChange={(event) => setCandidate((value) => ({ ...value, dailyCapacityMinutes: event.target.value }))} /><input aria-label="Candidate Resource hourly rate" type="number" min="0" placeholder="JPY/hour" value={candidate.costRateMinorPerHour} onChange={(event) => setCandidate((value) => ({ ...value, costRateMinorPerHour: event.target.value }))} /><select aria-label="Candidate Resource Skill" value={candidate.skillId} onChange={(event) => setCandidate((value) => ({ ...value, skillId: event.target.value }))}><option value="">No Skill</option>{project.skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select><button type="button" onClick={addCandidate}>Add candidate</button></div>{candidates.map((resource) => <p key={resource.id}><strong>{resource.name}</strong><span>{hours(resource.dailyCapacityMinutes)}/day · {money(resource.costRateMinorPerHour)}/h</span><button aria-label={`Remove ${resource.name}`} onClick={() => setCandidates((items) => items.filter((item) => item.id !== resource.id))}>×</button></p>)}</section></div>
          <footer><span>{allConfirmed ? `${unfinished.length} Task inputs confirmed` : "Confirm every unfinished Task after reviewing its suggestion."}</span><button className="primary-button" disabled={!canSubmit} onClick={submit}>{busy ? "Submitting…" : "Request proposal"}</button></footer>
        </section>
        {selected === null ? <section className="staffing-empty"><strong>Select or request a Proposal</strong><p>Current remains unchanged throughout optimization.</p></section> : <section className="staffing-result"><header><div><span className="section-kicker">PERSISTED PROPOSAL</span><h3>{selected.name}</h3><p>{statusDetail(selected)}</p></div><span className={`staffing-status staffing-status--${selected.status.toLowerCase()}`}>{selected.status}</span></header>
          <div className="staffing-status-grid"><article><span>BASE REVISION</span><strong>{selected.baseProjectRevision}</strong></article><article><span>ALGORITHM</span><strong>{selected.latestRun?.algorithmVersion ?? "Pending"}</strong></article><article><span>RUN STATUS</span><strong>{selected.latestRun?.status ?? selected.status}</strong></article><article><span>SCENARIO</span><strong>{selected.linkedScenarioId === null ? "Not created" : "Draft linked"}</strong></article></div>
          {solution === null ? selected.status === "INFEASIBLE" || output?.status === "INFEASIBLE" ? <section className="staffing-infeasible"><h4>Constraints could not be satisfied together</h4><p>This is a conflicting set, not proof that any single constraint is the cause.</p><ul>{diagnostics.map((diagnostic, index) => <li key={`${diagnostic.constraint}-${index}`}><strong>{diagnostic.constraint}</strong> · {diagnostic.message}</li>)}</ul></section> : <section className="staffing-pending"><strong>{selected.status === "FAILED" ? "No plan was applied" : "Waiting for a verified result"}</strong><p>{statusDetail(selected)}</p></section> : <><section className="staffing-verified"><header><div><span className="section-kicker">DETERMINISTIC VERIFICATION</span><h4>Verified solver facts</h4></div><span>Numeric source of truth</span></header><div><article><span>FINISH</span><strong>{solution.metrics.finish}</strong></article><article><span>PLANNED LABOR</span><strong>{money(solution.metrics.plannedLaborCostMinor)}</strong></article><article><span>OVERTIME</span><strong>{hours(solution.metrics.overtimeMinutes)}</strong></article><article><span>PAIR / SCHEDULE CHANGES</span><strong>{solution.metrics.assignmentChanges} / {solution.metrics.scheduleChanges}</strong></article><article><span>CANDIDATES</span><strong>{solution.metrics.candidateResources}</strong></article><article><span>SKILL GAPS</span><strong>{solution.metrics.skillGapTaskIds.length}</strong></article></div></section><section className="staffing-ai"><span className="section-kicker">AI EXPLANATION · NARRATIVE ONLY</span><h4>{solution.explanation.summary || "No explanation supplied"}</h4><ul>{solution.explanation.details.map((detail, index) => <li key={`${index}-${detail}`}>{detail}</li>)}</ul><small>AI text cannot change the verified numbers or approve this proposal.</small></section><section className="staffing-diff"><h4>Exact Scenario command diff</h4>{changeDescriptions.length === 0 ? <p>No plan commands.</p> : <ol>{changeDescriptions.map((description, index) => <li key={`${index}-${description}`}>{description}</li>)}</ol>}</section></>}
          <footer><span>Opening the Scenario does not approve or publish it.</span><button className="primary-button" disabled={selected.status !== "READY" || selected.linkedScenarioId === null} onClick={() => selected.linkedScenarioId === null ? undefined : onOpenScenario(selected.linkedScenarioId)}>Review linked Scenario</button></footer>
        </section>}
      </div>
    </div>}
  </section>;
}
