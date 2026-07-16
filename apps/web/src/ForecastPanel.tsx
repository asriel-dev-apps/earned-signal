import { useEffect, useMemo, useState } from "react";
import type { ProjectState } from "@earned-signal/application";
import type { ForecastRunCreateInput } from "./forecast-contract.js";
import type { ForecastRunDocument, ProjectApiClient } from "./project-api-client.js";

const money = (value: number) => new Intl.NumberFormat("ja-JP", {
  style: "currency", currency: "JPY", maximumFractionDigits: 0,
}).format(value);
const date = (value: string) => new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
}).format(new Date(`${value}T00:00:00Z`));

function suggestedEstimate(task: ProjectState["tasks"][number]) {
  const likely = Math.max(60, Math.round(task.durationWorkingDays * 480 * (1 - task.progressPercent / 100)));
  return {
    taskId: task.id,
    optimisticMinutes: Math.max(1, Math.round(likely * 0.8)),
    mostLikelyMinutes: likely,
    pessimisticMinutes: Math.max(likely, Math.round(likely * 1.3)),
    provenance: "HUMAN_CONFIRMED" as const,
  };
}

function addCalendarDays(value: string, days: number): string {
  const result = new Date(`${value}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function ForecastPanel({
  project,
  projectRevision,
  scenarioId,
  scenarioRevision,
  scenarioDirty,
  client,
  defaultTargetDate,
}: {
  readonly project: ProjectState;
  readonly projectRevision: string | null;
  readonly scenarioId: string | null;
  readonly scenarioRevision: string | null;
  readonly scenarioDirty: boolean;
  readonly client: ProjectApiClient | undefined;
  readonly defaultTargetDate: string;
}) {
  const unfinished = useMemo(() => project.tasks.filter((task) => task.progressPercent < 100), [project]);
  const [estimates, setEstimates] = useState(() => unfinished.map(suggestedEstimate));
  const [seed, setSeed] = useState(20_260_717);
  const [minSamples, setMinSamples] = useState(2_000);
  const [maxSamples, setMaxSamples] = useState(10_000);
  const [checkEvery, setCheckEvery] = useState(1_000);
  const [tolerance, setTolerance] = useState(50);
  const [stableChecks, setStableChecks] = useState(2);
  const [correlateAll, setCorrelateAll] = useState(false);
  const [correlationBasisPoints, setCorrelationBasisPoints] = useState(3_000);
  const [estimatesConfirmed, setEstimatesConfirmed] = useState(false);
  const [targetDate, setTargetDate] = useState(defaultTargetDate || addCalendarDays(project.statusDate, 90));
  const [run, setRun] = useState<ForecastRunDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setEstimates(unfinished.map(suggestedEstimate));
    setEstimatesConfirmed(false);
  }, [unfinished]);
  useEffect(() => {
    if (defaultTargetDate !== "") setTargetDate(defaultTargetDate);
  }, [defaultTargetDate]);
  useEffect(() => {
    setRun(null);
    if (client === undefined || scenarioId === null || projectRevision === null || scenarioRevision === null) return;
    let cancelled = false;
    client.forecastRuns(scenarioId).then((runs) => {
      if (!cancelled) setRun(runs.find((candidate) =>
        candidate.sourceProjectRevision === projectRevision &&
        candidate.sourceScenarioRevision === scenarioRevision
      ) ?? null);
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : "Forecast Runs could not be loaded");
    });
    return () => { cancelled = true; };
  }, [client, projectRevision, scenarioId, scenarioRevision]);
  useEffect(() => {
    if (client === undefined || scenarioId === null || run === null || (run.status !== "REQUESTED" && run.status !== "RUNNING")) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      client.loadForecastRun(scenarioId, run.id).then((next) => {
        if (!cancelled) setRun(next);
      }).catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Forecast status could not be refreshed");
      });
    }, 1_500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [client, run, scenarioId]);

  const updateEstimate = (taskId: string, field: "optimisticMinutes" | "mostLikelyMinutes" | "pessimisticMinutes", hours: number) => {
    const minutes = Math.round(hours * 60);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10_000_000) return;
    setEstimates((items) => items.map((item) => item.taskId === taskId ? { ...item, [field]: minutes } : item));
    setEstimatesConfirmed(false);
  };
  const validEstimates = estimates.every((estimate) =>
    estimate.optimisticMinutes <= estimate.mostLikelyMinutes &&
    estimate.mostLikelyMinutes <= estimate.pessimisticMinutes);
  const targetOffsetDays = (new Date(`${targetDate}T00:00:00.000Z`).getTime() - new Date(`${project.statusDate}T00:00:00.000Z`).getTime()) / 86_400_000;
  const revisionMatches = run !== null && run.sourceProjectRevision === projectRevision && run.sourceScenarioRevision === scenarioRevision;
  const pending = revisionMatches && (run.status === "REQUESTED" || run.status === "RUNNING");
  const canRun = client !== undefined && projectRevision !== null && scenarioId !== null && scenarioRevision !== null && !scenarioDirty && !pending && unfinished.length > 0 && validEstimates && estimatesConfirmed &&
    Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffff_ffff &&
    Number.isSafeInteger(minSamples) && Number.isSafeInteger(maxSamples) && Number.isSafeInteger(checkEvery) &&
    minSamples >= 1_000 && maxSamples <= 50_000 && minSamples <= maxSamples && checkEvery >= 100 && checkEvery <= 5_000 &&
    minSamples % checkEvery === 0 && maxSamples % checkEvery === 0 && Number.isSafeInteger(tolerance) && tolerance >= 0 && tolerance <= 10_000 &&
    Number.isSafeInteger(stableChecks) && stableChecks >= 1 && stableChecks <= (maxSamples - minSamples) / checkEvery &&
    Number.isInteger(targetOffsetDays) && targetOffsetDays >= 0 && targetOffsetDays <= 366 &&
    (!correlateAll || (unfinished.length >= 2 && Number.isSafeInteger(correlationBasisPoints) && correlationBasisPoints >= 0 && correlationBasisPoints <= 9_500));
  const requestForecast = async () => {
    if (client === undefined || projectRevision === null || scenarioId === null || scenarioRevision === null || !canRun) return;
    setBusy(true); setMessage(null);
    try {
      const input: ForecastRunCreateInput = {
        expectedRevision: projectRevision,
        expectedScenarioRevision: scenarioRevision,
        estimates,
        correlationGroups: correlateAll ? [{ id: "all-tasks", taskIds: unfinished.map((task) => task.id), coefficientBasisPoints: correlationBasisPoints }] : [],
        seed,
        stopping: {
          minIterations: minSamples,
          maxIterations: maxSamples,
          checkEvery,
          quantileToleranceBasisPoints: tolerance,
          stableChecks,
        },
        targetDate,
      };
      const created = await client.requestForecastRun(scenarioId, input);
      setRun(created.run);
      setMessage(created.replayed ? "Existing Forecast Run resumed." : "Forecast Run queued from the exact revisions shown below.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Forecast Run could not be requested");
    } finally {
      setBusy(false);
    }
  };
  const result = revisionMatches && run.status === "READY" ? run.result : null;

  return <section className="forecast-panel" aria-labelledby="forecast-heading">
    <header className="forecast-heading">
      <div><span className="section-kicker">PROBABILISTIC FORECAST</span><h3 id="forecast-heading">Monte Carlo simulation</h3><p>Confirm three-point remaining-effort estimates, then calculate a reproducible range without changing Current or this Scenario.</p></div>
      <div className="forecast-revisions"><span aria-label={`Current revision ${projectRevision ?? "preview"}`}>Current r<strong>{projectRevision ?? "preview"}</strong></span><span aria-label={`Draft revision ${scenarioRevision ?? "preview"}`}>Draft r<strong>{scenarioRevision ?? "preview"}</strong></span></div>
    </header>
    {message === null ? null : <div className="forecast-message" role="status">{message}</div>}
    {scenarioDirty ? <div className="forecast-error" role="alert">Save and run the deterministic Scenario before simulating this draft revision.</div> : null}
    <div className="forecast-estimates-wrap"><table className="forecast-estimates"><thead><tr><th>Work package</th><th>Optimistic hours</th><th>Most likely hours</th><th>Pessimistic hours</th></tr></thead><tbody>{unfinished.map((task) => {
      const estimate = estimates.find((item) => item.taskId === task.id) ?? suggestedEstimate(task);
      return <tr key={task.id}><td><strong>{task.wbs}</strong> {task.name}</td>{(["optimisticMinutes", "mostLikelyMinutes", "pessimisticMinutes"] as const).map((field) => <td key={field}><input aria-label={`${task.name} ${field}`} type="number" min="0.02" step="0.5" value={Number((estimate[field] / 60).toFixed(2))} onChange={(event) => updateEstimate(task.id, field, Number(event.target.value))} disabled={busy} /></td>)}</tr>;
    })}</tbody></table></div>
    {!validEstimates ? <p className="forecast-error" role="alert">Each estimate must satisfy optimistic ≤ most likely ≤ pessimistic.</p> : null}
    <label className="forecast-confirmation"><input aria-label="Confirm remaining-effort estimates" type="checkbox" checked={estimatesConfirmed} onChange={(event) => setEstimatesConfirmed(event.target.checked)} disabled={!validEstimates || busy} /> I reviewed and confirm these remaining-effort estimates.</label>
    <div className="forecast-controls">
      <label>Seed<input aria-label="Forecast seed" type="number" min="0" max={0xffff_ffff} value={seed} onChange={(event) => setSeed(Number(event.target.value))} /></label>
      <label>Minimum samples<input aria-label="Minimum samples" type="number" min="1000" max="50000" step="1000" value={minSamples} onChange={(event) => setMinSamples(Number(event.target.value))} /></label>
      <label>Maximum samples<input aria-label="Maximum samples" type="number" min="1000" max="50000" step="1000" value={maxSamples} onChange={(event) => setMaxSamples(Number(event.target.value))} /></label>
      <label>Check every<input aria-label="Check every" type="number" min="100" max="5000" step="100" value={checkEvery} onChange={(event) => setCheckEvery(Number(event.target.value))} /></label>
      <label>Quantile tolerance (bp)<input aria-label="Quantile tolerance" type="number" min="0" max="10000" step="10" value={tolerance} onChange={(event) => setTolerance(Number(event.target.value))} /></label>
      <label>Stable checks<input aria-label="Stable checks" type="number" min="1" max="100" value={stableChecks} onChange={(event) => setStableChecks(Number(event.target.value))} /></label>
      <label>Target finish<input aria-label="Target finish date" type="date" min={project.statusDate} value={targetDate} onChange={(event) => setTargetDate(event.target.value)} /></label>
      {unfinished.length < 2 ? null : <div className="forecast-correlation-toggle"><label><input aria-label="Correlate all tasks" type="checkbox" checked={correlateAll} onChange={(event) => setCorrelateAll(event.target.checked)} /> Correlate all tasks</label><input aria-label="Correlation coefficient basis points" type="number" min="0" max="9500" step="100" value={correlationBasisPoints} disabled={!correlateAll} onChange={(event) => setCorrelationBasisPoints(Number(event.target.value))} /></div>}
    </div>
    <div className="forecast-run-row"><div><strong>{run === null ? "No simulation yet" : run.status}</strong><span>{run === null ? "Results will remain revision-pinned." : `Run ${run.id.slice(0, 8)} · Current r${run.sourceProjectRevision} · Scenario r${run.sourceScenarioRevision}`}</span></div><button className="primary-button" disabled={!canRun || busy} onClick={() => void requestForecast()}>{busy ? "Queueing…" : run?.status === "REQUESTED" || run?.status === "RUNNING" ? "Simulation running…" : "Run simulation"}</button></div>
    {run?.status === "FAILED" ? <div className="forecast-error" role="alert"><strong>{run.failure?.code ?? "SIMULATION_FAILED"}</strong><span>{run.failure?.message ?? "The simulation did not complete."}</span></div> : null}
    {result === null ? null : <div className="forecast-results">
      <div className="scenario-metrics"><ForecastMetric label="P50 FINISH" value={date(result.p50FinishDate)} detail="Median finish" /><ForecastMetric label="P80 FINISH" value={date(result.p80FinishDate)} detail="80% finish confidence" /><ForecastMetric label="TARGET PROBABILITY" value={`${(result.targetProbabilityBasisPoints / 100).toFixed(1)}%`} detail={`Finish by ${date(run!.targetDate)}`} /><ForecastMetric label="P80 COST" value={money(result.p80TotalCostMinor)} detail={`P50 ${money(result.p50TotalCostMinor)}`} /></div>
      <div className="forecast-result-meta"><span>{result.iterations.toLocaleString()} iterations</span><span>{result.converged ? "Converged" : "Maximum iterations reached"}</span><span>Seed {result.metadata.seed}</span><span>{result.metadata.algorithmVersion}</span></div>
      <div className="forecast-charts"><Histogram title="Finish distribution" buckets={result.finishHistogram} firstLabel={date(result.finishHistogram[0]!.finishDate)} lastLabel={date(result.finishHistogram.at(-1)!.finishDate)} /><Histogram title="Cost distribution" buckets={result.costHistogram} firstLabel={money(result.costHistogram[0]!.lowerBoundMinor)} lastLabel={money(result.costHistogram.at(-1)!.upperBoundMinor)} /></div>
    </div>}
  </section>;
}

function ForecastMetric({ label, value, detail }: { readonly label: string; readonly value: string; readonly detail: string }) {
  return <article className="scenario-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function Histogram({ title, buckets, firstLabel, lastLabel }: { readonly title: string; readonly buckets: readonly { readonly count: number }[]; readonly firstLabel: string; readonly lastLabel: string }) {
  const max = Math.max(...buckets.map((bucket) => bucket.count), 1);
  return <figure className="forecast-chart"><figcaption>{title}</figcaption><svg viewBox="0 0 480 150" role="img" aria-label={`${title} histogram`}>{buckets.map((bucket, index) => {
    const width = 460 / buckets.length;
    const height = 120 * bucket.count / max;
    return <rect key={index} x={10 + index * width} y={135 - height} width={Math.max(1, width - 2)} height={height} rx="2"><title>{bucket.count} samples</title></rect>;
  })}<line x1="10" y1="135" x2="470" y2="135" /></svg><div className="forecast-chart-range"><span>{firstLabel}</span><span>{lastLabel}</span></div></figure>;
}
