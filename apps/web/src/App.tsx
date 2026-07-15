import {
  CellStyleModule,
  ClientSideRowModelModule,
  ColumnAutoSizeModule,
  NumberEditorModule,
  RowSelectionModule,
  RowStyleModule,
  SelectEditorModule,
  TextEditorModule,
  themeQuartz,
  type CellValueChangedEvent,
  type ColDef,
  type SelectionChangedEvent,
} from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { useCallback, useMemo, useState } from "react";
import {
  applyProjectCommand,
  type ProjectCommand,
  type ProjectState,
  type ProjectTask,
} from "@earned-signal/application";
import { baselineProject, initialProject } from "./demo-project";
import { analyzeProject, type ProjectAnalysis } from "./project-analysis";

type ProjectMode = "current" | "baseline";
type WorkspaceView = "wbs" | "performance" | "team";

interface TaskRow extends ProjectTask {
  readonly actualHours: number;
  readonly dependenciesText: string;
  readonly constraintText: string;
  readonly assignmentsText: string;
  readonly requiredSkillsText: string;
  readonly earlyStart: string;
  readonly earlyFinish: string;
  readonly totalFloatWorkingDays: number;
  readonly critical: boolean;
  readonly constraintViolation?: NonNullable<ProjectTask["constraint"]>;
}

const gridTheme = themeQuartz.withParams({
  accentColor: "#176b5b",
  backgroundColor: "#ffffff",
  borderColor: "#dde4e0",
  borderRadius: 0,
  browserColorScheme: "light",
  cellHorizontalPaddingScale: 0.85,
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  fontSize: 13,
  foregroundColor: "#25342e",
  headerBackgroundColor: "#f6f8f6",
  headerFontSize: 11,
  headerFontWeight: 700,
  headerTextColor: "#64736d",
  rowBorder: true,
  rowHoverColor: "#f4f8f6",
  selectedRowBackgroundColor: "#eaf4f0",
  spacing: 7,
});

const gridModules = [
  ClientSideRowModelModule,
  ColumnAutoSizeModule,
  TextEditorModule,
  NumberEditorModule,
  SelectEditorModule,
  RowSelectionModule,
  CellStyleModule,
  RowStyleModule,
];

function formatCurrency(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
    notation: value >= 10_000_000 ? "compact" : "standard",
  }).format(value);
}

function formatRatio(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

function formatBudgetVariance(value: number | null): string {
  if (value === null) {
    return "Forecast unavailable";
  }
  if (value === 0) {
    return "On budget";
  }
  return `${formatCurrency(Math.abs(value))} ${value < 0 ? "over" : "under"} budget`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function Icon({ name }: { readonly name: "grid" | "pulse" | "users" | "layers" | "settings" }) {
  const paths = {
    grid: "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z",
    pulse: "M3 12h4l2-6 4 12 2-6h6",
    users: "M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7.5 4a4 4 0 0 1 4 4v2m-2-10a4 4 0 0 0 0-8",
    layers: "m4 9 8-5 8 5-8 5-8-5Zm0 5 8 5 8-5",
    settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19 12a7 7 0 0 0-.08-1l2-1.55-2-3.46-2.46 1A7.2 7.2 0 0 0 14.72 6L14.4 3h-4.8l-.32 3a7.2 7.2 0 0 0-1.74 1L5.08 6l-2 3.46L5.08 11A7 7 0 0 0 5 12c0 .34.03.67.08 1l-2 1.55 2 3.46 2.46-1a7.2 7.2 0 0 0 1.74 1l.32 3h4.8l.32-3a7.2 7.2 0 0 0 1.74-1l2.46 1 2-3.46-2-1.55c.05-.33.08-.66.08-1Z",
  } as const;
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d={paths[name]} />
    </svg>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone?: "neutral" | "risk" | "good";
}) {
  return (
    <article className={`metric-card metric-card--${tone}`}>
      <div className="metric-label">
        <span>{label}</span>
        <span className="metric-dot" />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function PerformanceBars({ analysis }: { readonly analysis: ProjectAnalysis }) {
  const bars = [
    { label: "Planned value", short: "PV", value: analysis.evm.pv, color: "#83928c" },
    { label: "Earned value", short: "EV", value: analysis.evm.ev, color: "#1d7665" },
    { label: "Actual cost", short: "AC", value: analysis.evm.ac, color: "#d38348" },
  ];
  const maximum = Math.max(analysis.evm.bac, ...bars.map((bar) => bar.value), 1);
  return (
    <section className="performance-card">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">AS OF STATUS DATE</span>
          <h2>Cost performance</h2>
        </div>
        <span className="status-pill">Live</span>
      </div>
      <div className="performance-bars">
        {bars.map((bar) => (
          <div className="performance-row" key={bar.short}>
            <div className="performance-label">
              <span>{bar.short}</span>
              <small>{bar.label}</small>
            </div>
            <div className="bar-track">
              <span
                className="bar-fill"
                style={{ backgroundColor: bar.color, width: `${(bar.value / maximum) * 100}%` }}
              />
            </div>
            <strong>{formatCurrency(bar.value)}</strong>
          </div>
        ))}
      </div>
      <div className="budget-marker">
        <span />
        <small>BAC {formatCurrency(analysis.evm.bac)}</small>
      </div>
      <div className="variance-grid">
        <div>
          <span>Schedule variance</span>
          <strong>{formatCurrency(analysis.evm.sv)}</strong>
        </div>
        <div>
          <span>Cost variance</span>
          <strong>{formatCurrency(analysis.evm.cv)}</strong>
        </div>
      </div>
    </section>
  );
}

function TaskDetail({
  task,
  row,
  project,
}: {
  readonly task: ProjectTask | null;
  readonly row: TaskRow | undefined;
  readonly project: ProjectState;
}) {
  return (
    <section className="task-detail">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">SELECTED WORK PACKAGE</span>
          <h2>{task?.name ?? "Select a row"}</h2>
        </div>
        {row?.critical === true ? <span className="critical-pill">Critical</span> : null}
      </div>
      {task === null || row === undefined ? (
        <p className="empty-detail">Choose a task to inspect its schedule and actuals.</p>
      ) : (
        <>
        {row.constraintViolation === undefined ? null : (
          <p className="constraint-warning">Forecast violates {formatConstraint(task)}.</p>
        )}
        <dl className="detail-grid">
          <div>
            <dt>Owner</dt>
            <dd>{task.owner || "Unassigned"}</dd>
          </div>
          <div>
            <dt>Current dates</dt>
            <dd>{formatDate(row.earlyStart)} – {formatDate(row.earlyFinish)}</dd>
          </div>
          <div>
            <dt>Actual effort</dt>
            <dd>{(task.actualMinutes / 60).toLocaleString()} h</dd>
          </div>
          <div>
            <dt>Total float</dt>
            <dd>{row.totalFloatWorkingDays} working days</dd>
          </div>
          <div>
            <dt>WBS parent</dt>
            <dd>{project.wbsGroups.find((group) => group.id === task.wbsParentId)?.name ?? "Root"}</dd>
          </div>
          <div>
            <dt>Calendar</dt>
            <dd>{project.calendars.find((calendar) => calendar.id === task.calendarId)?.name ?? task.calendarId}</dd>
          </div>
          <div className="detail-grid--wide">
            <dt>Dependencies</dt>
            <dd>{row.dependenciesText || "None"}</dd>
          </div>
          <div className="detail-grid--wide">
            <dt>Constraint</dt>
            <dd>{row.constraintText || "None"}</dd>
          </div>
          <div className="detail-grid--wide">
            <dt>Assignments</dt>
            <dd>{row.assignmentsText || "None"}</dd>
          </div>
          <div className="detail-grid--wide">
            <dt>Required skills</dt>
            <dd>{task.requiredSkillIds
              .map((skillId) => project.skills.find((skill) => skill.id === skillId)?.name ?? skillId)
              .join(", ") || "None"}</dd>
          </div>
        </dl>
        </>
      )}
    </section>
  );
}

const constraintTypeByCode = {
  SNET: "START_NO_EARLIER_THAN",
  FNLT: "FINISH_NO_LATER_THAN",
  MSO: "MUST_START_ON",
  MFO: "MUST_FINISH_ON",
} as const;

function formatDependencies(task: ProjectTask): string {
  return task.dependencies
    .map(
      (dependency) =>
        `${dependency.predecessorId} ${dependency.type}${
          dependency.lagWorkingDays === 0 ? "" : `+${String(dependency.lagWorkingDays)}`
        }`,
    )
    .join(", ");
}

function formatConstraint(task: ProjectTask): string {
  if (task.constraint === null) return "";
  const code = Object.entries(constraintTypeByCode).find(
    ([, type]) => type === task.constraint?.type,
  )?.[0];
  return `${code ?? task.constraint.type} ${task.constraint.date}`;
}

function formatAssignments(taskId: string, project: ProjectState): string {
  return project.assignments
    .filter((assignment) => assignment.taskId === taskId)
    .map((assignment) => `${assignment.resourceId} ${String(assignment.unitsPercent)}%`)
    .join(", ");
}

function parseAssignments(value: unknown, project: ProjectState) {
  const text = String(value ?? "").trim();
  if (text.length === 0) return [];
  const resourceIds = new Set(project.resources.map((resource) => resource.id));
  return text.split(",").map((entry) => {
    const match = /^(\S+)\s+(\d{1,3})%$/.exec(entry.trim());
    if (match === null) throw new Error("Assignments use ‘Resource 100%’, separated by commas");
    const resourceId = match[1] ?? "";
    if (!resourceIds.has(resourceId)) throw new Error(`Unknown resource: ${resourceId}`);
    return { resourceId, unitsPercent: Number(match[2]) };
  });
}

function parseDependencies(value: unknown, project: ProjectState) {
  const text = String(value ?? "").trim();
  if (text.length === 0) return [];
  const taskIds = new Set(project.tasks.map((task) => task.id));
  return text.split(",").map((entry) => {
    const match = /^([^\s]+)\s+(FS|SS|FF|SF)(?:\+(\d+))?$/i.exec(entry.trim());
    if (match === null) {
      throw new Error("Dependencies use ‘Task FS+lag’, separated by commas");
    }
    const predecessorId = match[1] ?? "";
    if (!taskIds.has(predecessorId)) throw new Error(`Unknown predecessor: ${predecessorId}`);
    return {
      predecessorId,
      type: (match[2] ?? "FS").toUpperCase() as "FS" | "SS" | "FF" | "SF",
      lagWorkingDays: Number(match[3] ?? 0),
    };
  });
}

function parseConstraint(value: unknown): ProjectTask["constraint"] {
  const text = String(value ?? "").trim();
  if (text.length === 0) return null;
  const match = /^(SNET|FNLT|MSO|MFO)\s+(\d{4}-\d{2}-\d{2})$/i.exec(text);
  if (match === null) throw new Error("Constraints use ‘SNET|FNLT|MSO|MFO YYYY-MM-DD’");
  const code = (match[1] ?? "").toUpperCase() as keyof typeof constraintTypeByCode;
  return { type: constraintTypeByCode[code], date: match[2] ?? "" };
}

function changesForField(
  field: string,
  value: unknown,
  project: ProjectState,
): Partial<Omit<ProjectTask, "id">> {
  if (field === "name" || field === "owner" || field === "wbs") {
    return { [field]: String(value ?? "") };
  }
  if (field === "wbsParentId") {
    return { wbsParentId: value === null || value === "" ? null : String(value) };
  }
  if (field === "calendarId") {
    return { calendarId: String(value ?? "") };
  }
  if (field === "dependenciesText") {
    return { dependencies: parseDependencies(value, project) };
  }
  if (field === "constraintText") {
    return { constraint: parseConstraint(value) };
  }
  if (field === "requiredSkillsText") {
    const ids = String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (ids.some((id) => !project.skills.some((skill) => skill.id === id))) {
      throw new Error("Required skills must reference configured skill IDs");
    }
    return { requiredSkillIds: ids };
  }
  const numericValue = Number(value);
  if (field === "durationWorkingDays") {
    return { durationWorkingDays: numericValue };
  }
  if (field === "progressPercent") {
    return { progressPercent: numericValue };
  }
  if (field === "actualHours") {
    return { actualMinutes: Math.round(numericValue * 60) };
  }
  if (field === "budget" || field === "actualCost") {
    return { [field]: numericValue };
  }
  return {};
}

function trendPath(
  values: readonly number[],
  maximum: number,
  width = 900,
  height = 250,
): string {
  const left = 42;
  const right = width - 24;
  const top = 18;
  const bottom = height - 38;
  return values
    .map((value, index) => {
      const x = values.length === 1 ? right : left + ((right - left) * index) / (values.length - 1);
      const y = bottom - ((bottom - top) * value) / maximum;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function PerformanceWorkspace({
  project,
  analysis,
}: {
  readonly project: ProjectState;
  readonly analysis: ProjectAnalysis;
}) {
  const snapshots = analysis.performanceHistory;
  const latest = snapshots.at(-1);
  const maximum = Math.max(
    1,
    ...snapshots.flatMap((snapshot) => [
      snapshot.metrics.bac,
      snapshot.metrics.pv,
      snapshot.metrics.ev,
      snapshot.metrics.ac,
    ]),
  );
  const lines = [
    { key: "pv", label: "Planned value", color: "#8b9993", values: snapshots.map((snapshot) => snapshot.metrics.pv) },
    { key: "ev", label: "Earned value", color: "#1d7665", values: snapshots.map((snapshot) => snapshot.metrics.ev) },
    { key: "ac", label: "Actual cost", color: "#d38348", values: snapshots.map((snapshot) => snapshot.metrics.ac) },
  ] as const;
  return (
    <section className="performance-workspace" aria-label="Performance history">
      <div className="performance-summary">
        <MetricCard label="SCHEDULE VARIANCE" value={formatCurrency(latest?.metrics.sv ?? null)} detail={`SPI ${formatRatio(latest?.metrics.spi ?? null)}`} tone={(latest?.metrics.sv ?? 0) < 0 ? "risk" : "good"} />
        <MetricCard label="COST VARIANCE" value={formatCurrency(latest?.metrics.cv ?? null)} detail={`CPI ${formatRatio(latest?.metrics.cpi ?? null)}`} tone={(latest?.metrics.cv ?? 0) < 0 ? "risk" : "good"} />
        <MetricCard label="ESTIMATE AT COMPLETION" value={formatCurrency(latest?.metrics.eac ?? null)} detail={formatBudgetVariance(latest?.metrics.vac ?? null)} tone={(latest?.metrics.vac ?? 0) < 0 ? "risk" : "good"} />
        <MetricCard label="TO-COMPLETE INDEX" value={formatRatio(latest?.metrics.tcpi ?? null)} detail="TCPI · required efficiency" tone={(latest?.metrics.tcpi ?? 0) > 1 ? "risk" : "good"} />
      </div>
      <div className="performance-layout">
        <article className="trend-card">
          <header>
            <div>
              <span className="section-kicker">WEEKLY STATUS HISTORY</span>
              <h2>Value and cost trend</h2>
            </div>
            <div className="trend-legend">
              {lines.map((line) => <span key={line.key}><i style={{ backgroundColor: line.color }} />{line.label}</span>)}
            </div>
          </header>
          <svg viewBox="0 0 900 250" role="img" aria-label="Planned value, earned value, and actual cost by weekly status date">
            {[0.25, 0.5, 0.75, 1].map((fraction) => (
              <g key={fraction}>
                <line x1="42" x2="876" y1={212 - 194 * fraction} y2={212 - 194 * fraction} className="trend-gridline" />
                <text x="6" y={216 - 194 * fraction}>{formatCurrency(maximum * fraction)}</text>
              </g>
            ))}
            {lines.map((line) => (
              <path key={line.key} d={trendPath(line.values, maximum)} fill="none" stroke={line.color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {snapshots.map((snapshot, index) => {
              const x = snapshots.length === 1 ? 876 : 42 + (834 * index) / (snapshots.length - 1);
              return <text key={snapshot.period.statusDate} x={x} y="238" textAnchor="middle">{formatDate(snapshot.period.statusDate)}</text>;
            })}
          </svg>
        </article>
        <article className="variance-card">
          <header>
            <div>
              <span className="section-kicker">ATTENTION REQUIRED</span>
              <h2>Largest WBS variances</h2>
            </div>
            <span className="status-pill">As of {latest === undefined ? "—" : formatDate(latest.period.statusDate)}</span>
          </header>
          <div className="variance-table" role="table" aria-label="Largest WBS variances">
            <div className="variance-table__header" role="row"><span>Work package</span><span>Schedule</span><span>Cost</span></div>
            {latest?.wbsVariances.slice(0, 6).map((variance) => {
              const task = project.tasks.find((candidate) => candidate.id === variance.id);
              return (
                <div className="variance-table__row" role="row" key={variance.id}>
                  <span><strong>{variance.wbs}</strong>{task?.name ?? variance.id}</span>
                  <span className={variance.sv < 0 ? "risk-text" : ""}>{formatCurrency(variance.sv)}</span>
                  <span className={variance.cv < 0 ? "risk-text" : ""}>{formatCurrency(variance.cv)}</span>
                </div>
              );
            })}
          </div>
        </article>
      </div>
    </section>
  );
}

function TeamWorkload({
  project,
  analysis,
}: {
  readonly project: ProjectState;
  readonly analysis: ProjectAnalysis;
}) {
  return (
    <section className="team-workload" aria-label="Team workload">
      <div className="team-summary">
        <div>
          <span>TEAM MEMBERS</span>
          <strong>{project.resources.length}</strong>
        </div>
        <div>
          <span>OVER-ALLOCATED</span>
          <strong className={analysis.capacity.overallocatedResourceIds.length > 0 ? "risk-text" : ""}>
            {analysis.capacity.overallocatedResourceIds.length}
          </strong>
        </div>
        <div>
          <span>PLANNED LABOR</span>
          <strong>{formatCurrency(analysis.capacity.resources.reduce(
            (total, resource) => total + resource.plannedLaborCostMinor,
            0,
          ))}</strong>
        </div>
        <div>
          <span>SKILL GAPS</span>
          <strong className={analysis.capacity.skillGapActivityIds.length > 0 ? "risk-text" : ""}>
            {analysis.capacity.skillGapActivityIds.length}
          </strong>
        </div>
      </div>
      <div className="resource-list">
        {analysis.capacity.resources.map((capacity) => {
          const resource = project.resources.find((candidate) => candidate.id === capacity.resourceId);
          if (resource === undefined) return null;
          const assignedTasks = project.assignments
            .filter((assignment) => assignment.resourceId === resource.id)
            .map((assignment) => project.tasks.find((task) => task.id === assignment.taskId)?.name)
            .filter((name): name is string => name !== undefined);
          const skillNames = resource.skillIds
            .map((skillId) => project.skills.find((skill) => skill.id === skillId)?.name)
            .filter((name): name is string => name !== undefined);
          const busiestDays = capacity.days
            .filter((day) => day.demandMinutes > 0)
            .sort((left, right) => right.demandMinutes - left.demandMinutes)
            .slice(0, 5);
          return (
            <article className="resource-card" key={resource.id}>
              <header>
                <div>
                  <span className="resource-id">{resource.id}</span>
                  <h2>{resource.name}</h2>
                  <p>{skillNames.join(" · ") || "No skills recorded"}</p>
                </div>
                <div className={capacity.overallocatedMinutes > 0 ? "load-pill load-pill--risk" : "load-pill"}>
                  {capacity.utilizationPercent.toFixed(0)}% utilized
                </div>
              </header>
              <div className="resource-meta">
                <span>{resource.dailyCapacityMinutes / 60} h/day</span>
                <span>{formatCurrency(resource.costRateMinorPerHour)}/h</span>
                <span>{assignedTasks.length} assignments</span>
                {capacity.skillGapActivityIds.length > 0 ? (
                  <span className="risk-text">{capacity.skillGapActivityIds.length} skill gaps</span>
                ) : null}
              </div>
              <div className="load-days">
                {busiestDays.map((day) => {
                  const ratio = day.capacityMinutes === 0 ? 0 : day.demandMinutes / day.capacityMinutes;
                  return (
                    <div className="load-day" key={day.date}>
                      <span>{formatDate(day.date)}</span>
                      <div><i
                        className={day.overallocatedMinutes > 0 ? "load-bar load-bar--risk" : "load-bar"}
                        style={{ width: `${Math.min(100, ratio * 100)}%` }}
                      /></div>
                      <strong>{(day.demandMinutes / 60).toFixed(1)} h</strong>
                    </div>
                  );
                })}
              </div>
              <footer>{assignedTasks.join(" · ") || "No work packages assigned"}</footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function App() {
  const [currentProject, setCurrentProject] = useState<ProjectState>(initialProject);
  const [mode, setMode] = useState<ProjectMode>("current");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("wbs");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>("A4");
  const [notice, setNotice] = useState<string | null>(null);
  const displayedProject = mode === "baseline" ? baselineProject : currentProject;
  const currentAnalysis = useMemo(
    () => analyzeProject(currentProject, baselineProject),
    [currentProject],
  );
  const analysis = useMemo(
    () => mode === "current" ? currentAnalysis : analyzeProject(baselineProject, baselineProject),
    [currentAnalysis, mode],
  );
  const rows = useMemo<readonly TaskRow[]>(
    () =>
      displayedProject.tasks.map((task) => {
        const scheduled = analysis.scheduleById.get(task.id);
        if (scheduled === undefined) {
          throw new Error(`Task ${task.id} has no schedule result`);
        }
        return {
          ...task,
          actualHours: task.actualMinutes / 60,
          dependenciesText: formatDependencies(task),
          constraintText: formatConstraint(task),
          assignmentsText: formatAssignments(task.id, displayedProject),
          requiredSkillsText: task.requiredSkillIds.join(", "),
          ...scheduled,
        };
      }),
    [analysis, displayedProject],
  );

  const executeCommand = useCallback((command: ProjectCommand): boolean => {
    try {
      const candidate = applyProjectCommand(currentProject, command);
      analyzeProject(candidate, baselineProject);
      setCurrentProject(candidate);
      setNotice(null);
      return true;
    } catch (error) {
      setCurrentProject((project) => ({ ...project }));
      setNotice(error instanceof Error ? error.message : "The edit could not be applied");
      return false;
    }
  }, [currentProject]);

  const onCellValueChanged = useCallback(
    (event: CellValueChangedEvent<TaskRow>) => {
      if (mode !== "current" || event.data === undefined || event.colDef.field === undefined) {
        return;
      }
      try {
        if (event.colDef.field === "assignmentsText") {
          executeCommand({
            type: "assignment.replace",
            taskId: event.data.id,
            assignments: parseAssignments(event.newValue, currentProject),
          });
          return;
        }
        const changes = changesForField(event.colDef.field, event.newValue, currentProject);
        executeCommand({
          type: "task.update",
          taskId: event.data.id,
          changes,
        });
      } catch (error) {
        setCurrentProject((project) => ({ ...project }));
        setNotice(error instanceof Error ? error.message : "The edit could not be applied");
      }
    },
    [currentProject, executeCommand, mode],
  );

  const wbsParentValues = useMemo(
    () => ["", ...displayedProject.wbsGroups.map((group) => group.id)],
    [displayedProject.wbsGroups],
  );
  const calendarValues = useMemo(
    () => displayedProject.calendars.map((calendar) => calendar.id),
    [displayedProject.calendars],
  );
  const editable = mode === "current";
  const columnDefs = useMemo<ColDef<TaskRow>[]>(
    () => [
      { field: "wbs", headerName: "WBS", pinned: "left", width: 82, editable, cellClass: "editable-cell" },
      {
        field: "wbsParentId",
        headerName: "Parent",
        width: 112,
        editable,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: wbsParentValues },
        valueFormatter: ({ value }) => {
          const group = displayedProject.wbsGroups.find((candidate) => candidate.id === value);
          return group === undefined ? "Root" : `${group.code} ${group.name}`;
        },
        cellClass: "editable-cell hierarchy-cell",
      },
      {
        field: "name",
        headerName: "Work package",
        pinned: "left",
        minWidth: 210,
        flex: 1,
        editable,
        cellClass: "editable-cell task-name-cell",
        valueFormatter: ({ value }) => `↳ ${String(value ?? "")}`,
      },
      { field: "owner", headerName: "Owner", width: 132, editable, cellClass: "editable-cell" },
      {
        field: "assignmentsText",
        headerName: "Assignments",
        width: 170,
        editable,
        cellClass: "editable-cell assignment-cell",
        valueFormatter: ({ value }) => (value === "" ? "—" : String(value)),
      },
      {
        field: "requiredSkillsText",
        headerName: "Required skills",
        width: 145,
        editable,
        cellClass: "editable-cell",
        valueFormatter: ({ value }) => (value === "" ? "—" : String(value)),
      },
      {
        field: "durationWorkingDays",
        headerName: "Days",
        width: 76,
        editable,
        cellClass: "editable-cell numeric-cell",
      },
      {
        field: "dependenciesText",
        headerName: "Dependencies",
        width: 190,
        editable,
        cellClass: "editable-cell",
        valueFormatter: ({ value }) => (value === "" ? "—" : String(value)),
      },
      {
        field: "calendarId",
        headerName: "Calendar",
        width: 142,
        editable,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: calendarValues },
        valueFormatter: ({ value }) =>
          displayedProject.calendars.find((calendar) => calendar.id === value)?.name ?? String(value),
        cellClass: "editable-cell",
      },
      {
        field: "constraintText",
        headerName: "Constraint",
        width: 170,
        editable,
        cellClass: "editable-cell constraint-cell",
        valueFormatter: ({ value }) => (value === "" ? "—" : String(value)),
      },
      {
        field: "earlyFinish",
        headerName: "Forecast finish",
        width: 116,
        valueFormatter: ({ value }) => (typeof value === "string" ? formatDate(value) : "—"),
        cellClass: "calculated-cell",
      },
      {
        field: "budget",
        headerName: "Budget",
        width: 112,
        editable,
        valueFormatter: ({ value }) => formatCurrency(typeof value === "number" ? value : 0),
        cellClass: "editable-cell numeric-cell",
      },
      {
        field: "progressPercent",
        headerName: "Progress",
        width: 98,
        editable,
        valueFormatter: ({ value }) => `${String(value)}%`,
        cellClass: "editable-cell numeric-cell",
      },
      {
        field: "actualCost",
        headerName: "Actual cost",
        width: 118,
        editable,
        valueFormatter: ({ value }) => formatCurrency(typeof value === "number" ? value : 0),
        cellClass: "editable-cell numeric-cell",
      },
      {
        field: "actualHours",
        headerName: "Actual hours",
        width: 104,
        editable,
        valueFormatter: ({ value }) => `${String(value)} h`,
        cellClass: "editable-cell numeric-cell",
      },
    ],
    [calendarValues, displayedProject.calendars, displayedProject.wbsGroups, editable, wbsParentValues],
  );

  const selectedTask = displayedProject.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedRow = rows.find((row) => row.id === selectedTaskId);
  const forecastDifference = Math.round(
    (new Date(`${analysis.projectFinish}T00:00:00Z`).getTime() -
      new Date(`${analysis.baselineFinish}T00:00:00Z`).getTime()) /
      86_400_000,
  );
  const forecastDetail =
    forecastDifference === 0
      ? "On baseline"
      : `${Math.abs(forecastDifference)} calendar days ${forecastDifference > 0 ? "after" : "ahead of"} baseline`;

  const addTask = () => {
    const nextNumber =
      Math.max(0, ...currentProject.tasks.map((task) => Number(task.id.replace(/^A/, "")) || 0)) + 1;
    const task: ProjectTask = {
      id: `A${String(nextNumber)}`,
      wbs: `4.${String(nextNumber - currentProject.tasks.length)}`,
      wbsParentId: null,
      name: "New work package",
      owner: "",
      durationWorkingDays: 1,
      measurementMethod: "PHYSICAL_PERCENT",
      calendarId: currentProject.defaultCalendarId,
      dependencies: [],
      constraint: null,
      requiredSkillIds: [],
      budget: 0,
      progressPercent: 0,
      actualCost: 0,
      actualMinutes: 0,
    };
    if (executeCommand({ type: "task.add", task })) {
      setSelectedTaskId(task.id);
    }
  };

  const deleteTask = () => {
    if (selectedTaskId === null) {
      return;
    }
    if (executeCommand({ type: "task.delete", taskId: selectedTaskId })) {
      setSelectedTaskId(null);
    }
  };

  return (
    <AgGridProvider modules={gridModules}>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand-mark">ES</div>
          <nav aria-label="Primary">
            <button
              className={`nav-button ${workspaceView === "wbs" ? "nav-button--active" : ""}`}
              aria-label="Work breakdown"
              onClick={() => setWorkspaceView("wbs")}
            >
              <Icon name="grid" />
            </button>
            <button
              className={`nav-button ${workspaceView === "performance" ? "nav-button--active" : ""}`}
              aria-label="Performance history"
              onClick={() => {
                setMode("current");
                setWorkspaceView("performance");
              }}
            >
              <Icon name="pulse" />
            </button>
            <button
              className={`nav-button ${workspaceView === "team" ? "nav-button--active" : ""}`}
              aria-label="Team workload"
              onClick={() => {
                setWorkspaceView("team");
                setMode("current");
              }}
            >
              <Icon name="users" />
            </button>
            <button className="nav-button" aria-label="Scenarios">
              <Icon name="layers" />
            </button>
          </nav>
          <button className="nav-button nav-settings" aria-label="Settings">
            <Icon name="settings" />
          </button>
        </aside>

        <main className="workspace">
          <header className="topbar">
            <div className="project-switcher">
              <span className="project-avatar">CP</span>
              <div>
                <strong>{displayedProject.name}</strong>
                <small>Demo project · JPY</small>
              </div>
              <span className="chevron">⌄</span>
            </div>
            <div className="topbar-meta">
              <span>STATUS DATE</span>
              <strong>{formatDate(displayedProject.statusDate)}, 2026</strong>
            </div>
            <div className="saved-state"><span /> Demo session · not persisted</div>
            <button className="avatar-button" aria-label="Account">TM</button>
          </header>

          <div className="content">
            <div className="page-heading">
              <div>
                <p className="breadcrumb">PROJECTS / CUSTOMER PORTAL LAUNCH</p>
                <h1>{workspaceView === "wbs" ? "Project control" : workspaceView === "performance" ? "Performance" : "Team workload"}</h1>
              </div>
              <div className={`mode-switch ${workspaceView === "performance" ? "mode-switch--hidden" : ""}`} aria-label="Plan view">
                <button
                  className={mode === "current" ? "active" : ""}
                  onClick={() => setMode("current")}
                >
                  Current
                </button>
                <button
                  className={mode === "baseline" ? "active" : ""}
                  onClick={() => setMode("baseline")}
                  disabled={workspaceView === "team"}
                  title={workspaceView === "team" ? "Team workload currently shows the Current plan" : undefined}
                >
                  Baseline
                </button>
              </div>
            </div>

            {notice === null ? null : (
              <div className="notice" role="alert">
                <strong>Edit rejected</strong>
                <span>{notice}</span>
                <button onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
              </div>
            )}

            {workspaceView === "performance" ? (
              <PerformanceWorkspace project={currentProject} analysis={currentAnalysis} />
            ) : workspaceView === "team" ? (
              <TeamWorkload project={displayedProject} analysis={analysis} />
            ) : (
            <>
            <section className="metric-grid" aria-label="Key project metrics">
              <MetricCard
                label="FORECAST FINISH"
                value={formatDate(analysis.projectFinish)}
                detail={forecastDetail}
                tone={forecastDifference <= 0 ? "good" : "risk"}
              />
              <MetricCard
                label="SCHEDULE INDEX"
                value={formatRatio(analysis.evm.spi)}
                detail="SPI · earned vs planned"
                tone={(analysis.evm.spi ?? 1) < 1 ? "risk" : "good"}
              />
              <MetricCard
                label="COST INDEX"
                value={formatRatio(analysis.evm.cpi)}
                detail="CPI · value per cost"
                tone={(analysis.evm.cpi ?? 1) < 1 ? "risk" : "good"}
              />
              <MetricCard
                label="ESTIMATE AT COMPLETION"
                value={formatCurrency(analysis.evm.eac)}
                detail={formatBudgetVariance(analysis.evm.vac)}
                tone={(analysis.evm.vac ?? 0) < 0 ? "risk" : "good"}
              />
            </section>

            <div className="workspace-grid">
              <section className="grid-panel">
                <div className="grid-toolbar">
                  <div>
                    <h2>Work breakdown</h2>
                    <span>{displayedProject.tasks.length} work packages · hierarchy, calendars, links &amp; constraints editable</span>
                  </div>
                  <div className="toolbar-actions">
                    {mode === "baseline" ? <span className="readonly-pill">Read only</span> : null}
                    <button onClick={deleteTask} disabled={mode !== "current" || selectedTaskId === null}>
                      Delete
                    </button>
                    <button className="primary-button" onClick={addTask} disabled={mode !== "current"}>
                      <span>＋</span> Add work package
                    </button>
                  </div>
                </div>
                <div className="grid-wrap">
                  <AgGridReact<TaskRow>
                    theme={gridTheme}
                    rowData={[...rows]}
                    columnDefs={columnDefs}
                    defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: true }}
                    getRowId={({ data }) => data.id}
                    rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
                    onSelectionChanged={(event: SelectionChangedEvent<TaskRow>) => {
                      setSelectedTaskId(event.api.getSelectedRows()[0]?.id ?? null);
                    }}
                    onCellValueChanged={onCellValueChanged}
                    rowHeight={43}
                    headerHeight={39}
                    singleClickEdit
                    stopEditingWhenCellsLoseFocus
                    getRowClass={({ data }) => [
                      data?.critical === true ? "critical-row" : "",
                      data?.constraintViolation !== undefined ? "constraint-violation-row" : "",
                    ].filter(Boolean).join(" ")}
                  />
                </div>
                <footer className="grid-footer">
                  <span><i className="editable-key" /> Editable input</span>
                  <span><i className="calculated-key" /> Calculated by scheduling engine</span>
                  <span>Double-click or press Enter to edit</span>
                </footer>
              </section>

              <aside className="insight-column">
                <PerformanceBars analysis={analysis} />
                <TaskDetail task={selectedTask} row={selectedRow} project={displayedProject} />
              </aside>
            </div>
            </>
            )}
          </div>
        </main>
      </div>
    </AgGridProvider>
  );
}
