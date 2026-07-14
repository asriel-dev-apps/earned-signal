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

interface TaskRow extends ProjectTask {
  readonly actualHours: number;
  readonly earlyStart: string;
  readonly earlyFinish: string;
  readonly totalFloatWorkingDays: number;
  readonly critical: boolean;
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

function Icon({ name }: { readonly name: "grid" | "pulse" | "layers" | "settings" }) {
  const paths = {
    grid: "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z",
    pulse: "M3 12h4l2-6 4 12 2-6h6",
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
}: {
  readonly task: ProjectTask | null;
  readonly row: TaskRow | undefined;
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
        </dl>
      )}
    </section>
  );
}

function changesForField(field: string, value: unknown): Partial<Omit<ProjectTask, "id">> {
  if (field === "name" || field === "owner") {
    return { [field]: String(value ?? "") };
  }
  if (field === "predecessorId") {
    return { predecessorId: value === null || value === "" ? null : String(value) };
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

export function App() {
  const [currentProject, setCurrentProject] = useState<ProjectState>(initialProject);
  const [mode, setMode] = useState<ProjectMode>("current");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>("A4");
  const [notice, setNotice] = useState<string | null>(null);
  const displayedProject = mode === "baseline" ? baselineProject : currentProject;
  const analysis = useMemo(
    () => analyzeProject(displayedProject, baselineProject),
    [displayedProject],
  );
  const rows = useMemo<readonly TaskRow[]>(
    () =>
      displayedProject.tasks.map((task) => {
        const scheduled = analysis.scheduleById.get(task.id);
        if (scheduled === undefined) {
          throw new Error(`Task ${task.id} has no schedule result`);
        }
        return { ...task, actualHours: task.actualMinutes / 60, ...scheduled };
      }),
    [analysis, displayedProject.tasks],
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
        const changes = changesForField(event.colDef.field, event.newValue);
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
    [executeCommand, mode],
  );

  const predecessorValues = useMemo(
    () => ["", ...displayedProject.tasks.map((task) => task.id)],
    [displayedProject.tasks],
  );
  const editable = mode === "current";
  const columnDefs = useMemo<ColDef<TaskRow>[]>(
    () => [
      { field: "wbs", headerName: "WBS", pinned: "left", width: 74 },
      {
        field: "name",
        headerName: "Work package",
        pinned: "left",
        minWidth: 210,
        flex: 1,
        editable,
        cellClass: "editable-cell task-name-cell",
      },
      { field: "owner", headerName: "Owner", width: 132, editable, cellClass: "editable-cell" },
      {
        field: "durationWorkingDays",
        headerName: "Days",
        width: 76,
        editable,
        cellClass: "editable-cell numeric-cell",
      },
      {
        field: "predecessorId",
        headerName: "Pred.",
        width: 82,
        editable,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: predecessorValues },
        cellClass: "editable-cell",
        valueFormatter: ({ value }) => (value === null || value === "" ? "—" : String(value)),
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
    [editable, predecessorValues],
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
      name: "New work package",
      owner: "",
      durationWorkingDays: 1,
      measurementMethod: "PHYSICAL_PERCENT",
      predecessorId: null,
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
            <button className="nav-button nav-button--active" aria-label="Work breakdown">
              <Icon name="grid" />
            </button>
            <button className="nav-button" aria-label="Performance">
              <Icon name="pulse" />
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
                <h1>Project control</h1>
              </div>
              <div className="mode-switch" aria-label="Plan view">
                <button
                  className={mode === "current" ? "active" : ""}
                  onClick={() => setMode("current")}
                >
                  Current
                </button>
                <button
                  className={mode === "baseline" ? "active" : ""}
                  onClick={() => setMode("baseline")}
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
                    <span>{displayedProject.tasks.length} leaf work packages</span>
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
                    getRowClass={({ data }) => (data?.critical === true ? "critical-row" : undefined)}
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
                <TaskDetail task={selectedTask} row={selectedRow} />
              </aside>
            </div>
          </div>
        </main>
      </div>
    </AgGridProvider>
  );
}
