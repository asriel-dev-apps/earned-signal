import { useCallback, useEffect, useMemo, useState } from "react";
import {
  calculateScenario,
  type ProjectState,
  type ProjectTask,
  type ScenarioPlanCommand,
  type ScenarioResult,
} from "@earned-signal/application";
import type { ProjectAnalysis } from "./project-analysis";
import type { ProjectApiClient, ScenarioDocument } from "./project-api-client";
import { ForecastPanel } from "./ForecastPanel";

const money = (value: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(value);
const date = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

const fieldLabel = (field: string) => field.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase());
const valueLabel = (value: unknown) => typeof value === "string" || typeof value === "number"
  ? String(value)
  : JSON.stringify(value);

function describeChange(change: ScenarioPlanCommand, project: ProjectState): readonly string[] {
  if (change.type === "task.update") {
    const task = project.tasks.find((candidate) => candidate.id === change.taskId);
    return Object.entries(change.changes).map(([field, next]) =>
      `${task?.wbs ?? change.taskId} ${task?.name ?? "Unknown task"} · ${fieldLabel(field)}: ${valueLabel(task?.[field as keyof ProjectTask])} → ${valueLabel(next)}`,
    );
  }
  if (change.type === "task.add") return [`Add task · ${valueLabel(change.task)}`];
  if (change.type === "task.delete") {
    const task = project.tasks.find((candidate) => candidate.id === change.taskId);
    return [`Delete task · ${task?.wbs ?? change.taskId} ${task?.name ?? "Unknown task"}`];
  }
  if (change.type === "resource.add") return [`Add resource · ${valueLabel(change.resource)}`];
  if (change.type === "resource.update") {
    const resource = project.resources.find((candidate) => candidate.id === change.resourceId);
    return Object.entries(change.changes).map(([field, next]) =>
      `${resource?.name ?? change.resourceId} · ${fieldLabel(field)}: ${valueLabel(resource?.[field as keyof typeof resource])} → ${valueLabel(next)}`,
    );
  }
  if (change.type === "resource.delete") {
    const resource = project.resources.find((candidate) => candidate.id === change.resourceId);
    return [`Delete resource · ${resource?.name ?? change.resourceId}`];
  }
  const task = project.tasks.find((candidate) => candidate.id === change.taskId);
  return [`Replace assignments for ${task?.wbs ?? change.taskId} ${task?.name ?? "Unknown task"} · ${valueLabel(change.assignments)}`];
}

export function ScenarioWorkspace({ project, baseline, analysis, projectRevision, client, onPublished, initialScenarioId = null }: {
  readonly project: ProjectState;
  readonly baseline: ProjectState;
  readonly analysis: ProjectAnalysis;
  readonly projectRevision: string | null;
  readonly client: ProjectApiClient | undefined;
  readonly onPublished: () => Promise<void>;
  readonly initialScenarioId?: string | null;
}) {
  const previewChanges = useMemo<readonly ScenarioPlanCommand[]>(() => {
    const task = project.tasks[0];
    return task === undefined ? [] : [{ type: "task.update", taskId: task.id, changes: { durationWorkingDays: task.durationWorkingDays + 2, budget: Math.round(task.budget * 1.08) } }];
  }, [project]);
  const [scenarios, setScenarios] = useState<readonly ScenarioDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [changes, setChanges] = useState<readonly ScenarioPlanCommand[]>(previewChanges);
  const [newName, setNewName] = useState("Recovery plan");
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">(client === undefined ? "loaded" : "loading");
  const [message, setMessage] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<"publish" | "discard" | null>(null);
  const selected = scenarios.find((scenario) => scenario.id === selectedId) ?? null;

  const refresh = useCallback(async () => {
    if (client === undefined) return;
    setLoadState("loading");
    const loaded = await client.scenarios();
    setScenarios(loaded);
    const next = loaded.find((scenario) => scenario.id === initialScenarioId) ?? loaded[0] ?? null;
    setSelectedId(next?.id ?? null);
    setChanges(next?.changes ?? []);
    setLoadState("loaded");
  }, [client, initialScenarioId]);
  useEffect(() => {
    if (client === undefined) { setChanges(previewChanges); return; }
    refresh().catch((error: unknown) => {
      setLoadState("error");
      setMessage(error instanceof Error ? error.message : "Scenarios could not be loaded");
    });
  }, [client, previewChanges, refresh]);

  const dirty = selected !== null && JSON.stringify(changes) !== JSON.stringify(selected.changes);
  const localResult = useMemo(() => calculateScenario({ current: project, baseline, changes, trend: { spi: analysis.evm.spi, cpi: analysis.evm.cpi } }), [analysis.evm.cpi, analysis.evm.spi, baseline, changes, project]);
  const result: ScenarioResult = dirty ? localResult : (selected?.latestRun?.output ?? localResult);
  const stale = selected !== null && selected.baseProjectRevision !== projectRevision;
  const publishable = selected?.status === "DRAFT" && selected.latestRun !== null && changes.length > 0 && !dirty && !stale;
  const changeDescriptions = changes.flatMap((change) => describeChange(change, project));

  const updateTask = (taskId: string, field: "durationWorkingDays" | "budget", value: number) => {
    if (!Number.isSafeInteger(value) || value < (field === "durationWorkingDays" ? 1 : 0) || (field === "durationWorkingDays" && value > 10_000)) return;
    const existing = changes.find((change) => change.type === "task.update" && change.taskId === taskId);
    const remaining = changes.filter((change) => !(change.type === "task.update" && change.taskId === taskId));
    const task = project.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) return;
    const nextChanges = { ...(existing?.type === "task.update" ? existing.changes : {}), [field]: value };
    const differs = Object.entries(nextChanges).some(([key, entry]) => entry !== task[key as keyof ProjectTask]);
    setChanges(differs ? [...remaining, { type: "task.update", taskId, changes: nextChanges }] : remaining);
  };
  const withBusy = async (operation: () => Promise<void>) => {
    setBusy(true); setMessage(null);
    try { await operation(); } catch (error) { setMessage(error instanceof Error ? error.message : "Scenario operation failed"); }
    finally { setBusy(false); }
  };
  const create = () => withBusy(async () => {
    if (client === undefined) return;
    const created = await client.createScenario(newName);
    setScenarios((items) => [created, ...items]); setSelectedId(created.id); setChanges([]);
  });
  const saveAndRun = () => withBusy(async () => {
    if (client === undefined || selected === null) return;
    const saved = dirty ? await client.updateScenario(selected.id, selected.revision, changes) : selected;
    if (dirty) {
      setScenarios((items) => items.map((item) => item.id === saved.id ? saved : item));
      setChanges(saved.changes);
    }
    const ran = await client.runScenario(saved.id, saved.revision);
    setScenarios((items) => items.map((item) => item.id === ran.id ? ran : item)); setChanges(ran.changes);
    setMessage("Run saved from the exact Current and Scenario revisions.");
  });
  const confirm = () => withBusy(async () => {
    if (client === undefined || selected === null || confirmAction === null) return;
    if (confirmAction === "discard") {
      const discarded = await client.discardScenario(selected.id, selected.revision);
      setScenarios((items) => items.map((item) => item.id === discarded.id ? discarded : item)); setChanges(discarded.changes);
    } else if (projectRevision !== null) {
      await client.publishScenario(selected.id, projectRevision, selected.revision);
      setScenarios((items) => items.map((item) => item.id === selected.id ? { ...item, status: "PUBLISHED" } : item));
      setConfirmAction(null);
      await onPublished();
      await refresh();
    }
    setConfirmAction(null);
  });

  return <section className="scenario-workspace">
    <header className="scenario-heading"><div><span className="section-kicker">WHAT-IF PLANNING</span><h2>Scenarios</h2><p>Draft changes stay isolated until a human publishes them into Current. Baseline never changes.</p></div>{client === undefined ? <span className="scenario-safety">Preview only · Current unchanged</span> : <div className="scenario-create"><input aria-label="Scenario name" value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={200} disabled={loadState !== "loaded"} /><button className="primary-button" disabled={busy || loadState !== "loaded" || newName.trim() === ""} onClick={create}>New scenario</button></div>}</header>
    {message === null ? null : <div className="notice" role="alert"><strong>Scenario status</strong><span>{message}</span><button onClick={() => setMessage(null)} aria-label="Dismiss">×</button></div>}
    {client !== undefined && loadState !== "loaded" ? <section className="scenario-load-state" aria-live="polite"><strong>{loadState === "loading" ? "Loading Scenarios…" : "Scenarios could not be loaded"}</strong><p>{loadState === "loading" ? "Reading authorized Scenario drafts and immutable runs." : "The list is unavailable, so creating or publishing is disabled until it is reloaded."}</p>{loadState === "error" ? <button className="primary-button" onClick={() => refresh().catch((error: unknown) => { setLoadState("error"); setMessage(error instanceof Error ? error.message : "Scenarios could not be loaded"); })}>Retry loading</button> : null}</section> : <div className="scenario-layout"><aside className="scenario-list">{client === undefined ? <button className="active"><strong>Recovery preview</strong><span>Draft · Current unchanged</span></button> : scenarios.length === 0 ? <p>No Scenarios yet. Create one to branch from revision {projectRevision}.</p> : scenarios.map((scenario) => <button key={scenario.id} className={scenario.id === selectedId ? "active" : ""} onClick={() => { setSelectedId(scenario.id); setChanges(scenario.changes); }}><strong>{scenario.name}</strong><span>{scenario.status} · Scenario r{scenario.revision}</span></button>)}</aside>
      <div className="scenario-main"><div className="scenario-banner"><div><strong>Scenario draft · Current unchanged</strong><span>Based on Current revision {selected?.baseProjectRevision ?? projectRevision ?? "preview"}</span></div>{stale ? <span className="critical-pill">Stale · recreate from Current</span> : <span className="status-pill">deterministic-trend-v1</span>}</div>
        <div className="scenario-metrics"><ScenarioMetric label="CURRENT TREND FINISH" value={date(result.comparison.currentFinish)} detail={`${result.factors.schedule.toFixed(2)}× remaining duration${result.factors.scheduleFallback ? " · neutral fallback" : ""}`} /><ScenarioMetric label="SCENARIO FINISH" value={date(result.forecast.finish)} detail={`${result.factors.schedule.toFixed(2)}× remaining duration`} risk={result.forecast.finish > result.comparison.currentFinish} /><ScenarioMetric label="CURRENT TREND EAC" value={money(result.comparison.currentEac)} detail={`${result.factors.cost.toFixed(2)}× remaining budget${result.factors.costFallback ? " · neutral fallback" : ""}`} /><ScenarioMetric label="SCENARIO EAC" value={money(result.forecast.eac)} detail={`${result.factors.cost.toFixed(2)}× remaining budget`} risk={result.forecast.eac > result.comparison.currentEac} /></div>
        <div className="scenario-summary"><span>Planned labor <strong>{money(result.forecast.plannedLaborCost)}</strong></span><span>Overloaded resources <strong>{result.forecast.capacity.overallocatedResourceIds.length}</strong></span><span>Skill gaps <strong>{result.forecast.capacity.skillGapActivityIds.length}</strong></span><span>Changes <strong>{changes.length}</strong></span></div>
        <div className="scenario-table-wrap"><table className="scenario-table"><thead><tr><th>Work package</th><th>Current days</th><th>Scenario days</th><th>Current budget</th><th>Scenario budget</th><th>Current trend finish</th><th>Scenario finish</th></tr></thead><tbody>{project.tasks.map((task) => { const change = changes.find((candidate) => candidate.type === "task.update" && candidate.taskId === task.id); const planTask = result.plan.tasks.find((candidate) => candidate.id === task.id) ?? task; const currentTaskForecast = result.comparison.tasks.find((candidate) => candidate.taskId === task.id); const scenarioTaskForecast = result.forecast.tasks.find((candidate) => candidate.taskId === task.id); const editable = client === undefined || selected?.status === "DRAFT"; return <tr key={task.id}><td><strong>{task.wbs}</strong> {task.name}</td><td>{task.durationWorkingDays}</td><td><input aria-label={`${task.name} Scenario days`} type="number" min="1" max="10000" disabled={!editable || busy} value={planTask.durationWorkingDays} onChange={(event) => updateTask(task.id, "durationWorkingDays", Number(event.target.value))} /></td><td>{money(task.budget)}</td><td><input aria-label={`${task.name} Scenario budget`} type="number" min="0" disabled={!editable || busy} value={change?.type === "task.update" && change.changes.budget !== undefined ? change.changes.budget : task.budget} onChange={(event) => updateTask(task.id, "budget", Number(event.target.value))} /></td><td>{currentTaskForecast === undefined ? "—" : date(currentTaskForecast.finish)}</td><td>{scenarioTaskForecast === undefined ? "—" : date(scenarioTaskForecast.finish)}</td></tr>; })}</tbody></table></div>
        <section className="scenario-change-review"><h3>Changes included in approval</h3>{changeDescriptions.length === 0 ? <p>No plan changes.</p> : <ul>{changeDescriptions.map((description, index) => <li key={`${index}-${description}`}>{description}</li>)}</ul>}</section>
        <ForecastPanel project={result.plan} projectRevision={projectRevision} scenarioId={selected?.id ?? null} scenarioRevision={selected?.revision ?? null} scenarioDirty={dirty} client={client} defaultTargetDate={result.comparison.currentFinish} />
        <footer className="scenario-actions"><span>{selected?.latestRun === null ? "Run required before publish" : selected?.latestRun === undefined ? "Preview updates immediately" : `Run ${selected.latestRun.inputHash.slice(0, 8)} · ${new Date(selected.latestRun.createdAt).toLocaleString("en-US")}`}</span><div>{selected?.status === "DRAFT" ? <><button disabled={busy} onClick={() => setConfirmAction("discard")}>Discard</button><button disabled={busy || stale} onClick={saveAndRun}>{dirty ? "Save & run" : "Run forecast"}</button><button className="primary-button" disabled={busy || !publishable} onClick={() => setConfirmAction("publish")}>Publish to Current</button></> : null}</div></footer>
      </div></div>}
    {confirmAction === null ? null : <div className="dialog-backdrop" role="presentation"><div className="baseline-dialog" role="dialog" aria-modal="true"><span className="section-kicker">HUMAN APPROVAL</span><h2>{confirmAction === "publish" ? "Publish Scenario to Current?" : "Discard this Scenario?"}</h2><p>{confirmAction === "publish" ? `${changeDescriptions.length} field-level changes will update Current once. The approved Baseline remains unchanged.` : "This draft becomes terminal. Current and Baseline remain unchanged."}</p>{confirmAction === "publish" ? <ul className="scenario-dialog-changes">{changeDescriptions.map((description, index) => <li key={`${index}-${description}`}>{description}</li>)}</ul> : null}<div className="dialog-actions"><button onClick={() => setConfirmAction(null)}>Cancel</button><button className="primary-button" onClick={confirm}>{confirmAction === "publish" ? "Approve and publish" : "Discard Scenario"}</button></div></div></div>}
  </section>;
}

function ScenarioMetric({ label, value, detail, risk = false }: { readonly label: string; readonly value: string; readonly detail: string; readonly risk?: boolean }) {
  return <article className={`scenario-metric ${risk ? "scenario-metric--risk" : ""}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}
