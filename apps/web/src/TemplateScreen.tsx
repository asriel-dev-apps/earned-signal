import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyProjectCommand,
  type DependencyType,
  type ProjectCommand,
  type ProjectState,
  type SubtaskTemplate,
  type SubtaskTemplateStep,
} from "@vecta/application";
import { createDemoProject } from "./demo-project";
import { ProjectApiError, type ProjectApiClient } from "./project-api-client";

// The subtask-template management screen (Design 0003 §E-1). Templates are a
// project-scoped master: a name plus an ordered list of steps (名称 / 重み% /
// 依存 / ラグ). Every edit dispatches the same project command the grid uses, so
// generation (row menu → テンプレートから生成…) and this editor stay in sync via
// the server (the single source of truth in connected mode). Preview mode edits
// an in-memory demo without a backend.

type SaveState = "preview" | "loading" | "saved" | "saving" | "error";

const DEPENDENCY_TYPES: readonly DependencyType[] = ["FS", "SS", "FF", "SF"];

// Preview (dev/demo only): a small in-memory demo so the template list and its
// steps are populated without a backend.
function demoTemplateProject(): ProjectState {
  return createDemoProject({ parentCount: 8, subtasksPerParent: 3, memberCount: 8 });
}

const EMPTY_PROJECT: ProjectState = {
  id: "00000000-0000-4000-8000-000000000000",
  name: "",
  projectStart: "2026-01-01",
  statusDate: "2026-01-01",
  currency: "JPY",
  defaultCalendarId: "standard",
  calendars: [
    { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
  ],
  members: [],
  processes: [],
  products: [],
  templates: [],
  tasks: [],
};

function orderedTemplates(templates: readonly SubtaskTemplate[]): readonly SubtaskTemplate[] {
  return [...templates].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
  );
}

/** The step editor for the selected template: 名称 / 重み% / 依存 / ラグ. */
function StepEditor({
  steps,
  editable,
  onChange,
}: {
  readonly steps: readonly SubtaskTemplateStep[];
  readonly editable: boolean;
  readonly onChange: (steps: readonly SubtaskTemplateStep[]) => void;
}) {
  const totalPercent = steps.reduce((sum, step) => sum + step.weightBp, 0) / 100;

  const replaceStep = (index: number, next: SubtaskTemplateStep) => {
    onChange(steps.map((step, position) => (position === index ? next : step)));
  };
  const addStep = () => {
    onChange([...steps, { name: "Step", weightBp: 0 }]);
  };
  const removeStep = (index: number) => {
    // Dropping a step can leave the new first step carrying a dependency; strip it
    // so the first step never depends on a predecessor.
    const next = steps.filter((_step, position) => position !== index);
    onChange(next.map((step, position) => (position === 0 ? withoutDependency(step) : step)));
  };
  const moveStep = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    onChange(next.map((step, position) => (position === 0 ? withoutDependency(step) : step)));
  };

  return (
    <div className="template-steps" data-testid="template-steps">
      <div className="template-steps-head">
        <h3 className="template-steps-title">サブタスク構成</h3>
        <span className="template-steps-sum" data-testid="template-weight-sum">
          Σ重み {totalPercent}%
        </span>
      </div>
      <ol className="template-step-list">
        {steps.map((step, index) => (
          <li className="template-step-row" key={index} data-testid="template-step-row">
            <span className="template-step-index">{index + 1}</span>
            <input
              className="master-input template-step-name"
              defaultValue={step.name}
              disabled={!editable}
              aria-label="ステップ名称"
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (name !== "" && name !== step.name) replaceStep(index, { ...step, name });
                else event.target.value = step.name;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <input
              className="master-input template-step-weight"
              type="number"
              min={0}
              max={100}
              step={0.1}
              defaultValue={step.weightBp / 100}
              disabled={!editable}
              aria-label="重み%"
              onBlur={(event) => {
                const percent = Number(event.target.value);
                const weightBp = Math.min(10_000, Math.max(0, Math.round(percent * 100)));
                if (Number.isFinite(percent) && weightBp !== step.weightBp) {
                  replaceStep(index, { ...step, weightBp });
                } else {
                  event.target.value = String(step.weightBp / 100);
                }
              }}
            />
            <span className="master-unit">%</span>
            {index === 0 ? (
              <span className="template-step-dep template-step-dep--first">—</span>
            ) : (
              <>
                <select
                  className="master-input template-step-dep"
                  value={step.dependsOnPrev?.type ?? ""}
                  disabled={!editable}
                  aria-label="依存"
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "") {
                      replaceStep(index, withoutDependency(step));
                    } else {
                      replaceStep(index, {
                        ...step,
                        dependsOnPrev: {
                          type: value as DependencyType,
                          lagWorkingDays: step.dependsOnPrev?.lagWorkingDays ?? 0,
                        },
                      });
                    }
                  }}
                >
                  <option value="">なし</option>
                  {DEPENDENCY_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                <input
                  className="master-input template-step-lag"
                  type="number"
                  min={0}
                  step={1}
                  defaultValue={step.dependsOnPrev?.lagWorkingDays ?? 0}
                  disabled={!editable || step.dependsOnPrev === undefined}
                  aria-label="ラグ(営業日)"
                  onBlur={(event) => {
                    if (step.dependsOnPrev === undefined) return;
                    const lag = Math.trunc(Number(event.target.value));
                    if (Number.isFinite(lag) && lag >= 0 && lag !== step.dependsOnPrev.lagWorkingDays) {
                      replaceStep(index, {
                        ...step,
                        dependsOnPrev: { ...step.dependsOnPrev, lagWorkingDays: lag },
                      });
                    } else {
                      event.target.value = String(step.dependsOnPrev.lagWorkingDays);
                    }
                  }}
                />
                <span className="master-unit">営業日</span>
              </>
            )}
            <span className="template-step-actions">
              <button
                type="button"
                className="template-step-move"
                aria-label="上へ移動"
                disabled={!editable || index === 0}
                onClick={() => moveStep(index, -1)}
              >
                ▲
              </button>
              <button
                type="button"
                className="template-step-move"
                aria-label="下へ移動"
                disabled={!editable || index === steps.length - 1}
                onClick={() => moveStep(index, 1)}
              >
                ▼
              </button>
              <button
                type="button"
                className="master-delete"
                data-testid="template-step-delete"
                aria-label="ステップを削除"
                disabled={!editable}
                onClick={() => removeStep(index)}
              >
                削除
              </button>
            </span>
          </li>
        ))}
        {steps.length === 0 && <li className="master-empty">（ステップ未登録）</li>}
      </ol>
      <button
        type="button"
        className="master-add-button template-step-add"
        data-testid="template-step-add"
        disabled={!editable}
        onClick={addStep}
      >
        ステップを追加
      </button>
    </div>
  );
}

function withoutDependency(step: SubtaskTemplateStep): SubtaskTemplateStep {
  if (step.dependsOnPrev === undefined) return step;
  return { name: step.name, weightBp: step.weightBp };
}

export function TemplateScreen({ client }: { readonly client?: ProjectApiClient }) {
  const [project, setProject] = useState<ProjectState>(() =>
    client === undefined ? demoTemplateProject() : EMPTY_PROJECT,
  );
  const [revision, setRevision] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(client === undefined ? "preview" : "loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const saving = useRef(false);

  const reload = useCallback(async () => {
    if (client === undefined) return;
    const workspace = await client.load();
    setProject(workspace.current);
    setRevision(workspace.revision);
  }, [client]);

  useEffect(() => {
    if (client === undefined) return;
    let active = true;
    setSaveState("loading");
    reload()
      .then(() => {
        if (active) setSaveState("saved");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSaveState("error");
        setNotice(error instanceof Error ? error.message : "The project could not be loaded");
      });
    return () => {
      active = false;
    };
  }, [client, reload]);

  const executeCommand = useCallback(
    (command: ProjectCommand): void => {
      if (saving.current) return;
      const previousProject = project;
      let candidate: ProjectState;
      try {
        candidate = applyProjectCommand(project, command);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "The edit could not be applied");
        return;
      }
      setProject(candidate);
      setNotice(null);
      if (client !== undefined && revision !== null) {
        const backend = client;
        saving.current = true;
        setSaveState("saving");
        backend
          .execute(command, revision)
          .then(async (result) => {
            setRevision(result.revision);
            setSaveState("saved");
            try {
              await reload();
            } catch {
              setNotice("Saved, but the templates could not be refreshed. Reload to retrieve them.");
            }
          })
          .catch((error: unknown) => {
            setProject(previousProject);
            setSaveState("error");
            if (error instanceof ProjectApiError && error.code === "VERSION_CONFLICT") {
              setNotice("This project changed elsewhere; your edit was not saved. Reload and retry.");
            } else {
              setNotice(error instanceof Error ? error.message : "The edit could not be saved");
            }
          })
          .finally(() => {
            saving.current = false;
          });
      }
    },
    [client, project, revision, reload],
  );

  const editable = saveState === "preview" || saveState === "saved";
  const templates = orderedTemplates(project.templates);
  const selected =
    templates.find((template) => template.id === selectedId) ?? templates[0] ?? null;

  const nextSortOrder = project.templates.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;

  const commitAdd = () => {
    const name = draft.trim();
    if (name === "") return;
    const id = crypto.randomUUID();
    executeCommand({
      type: "template.add",
      template: { id, name, sortOrder: nextSortOrder, subtasks: [] },
    });
    setSelectedId(id);
    setDraft("");
  };

  return (
    <div className="app-shell master-shell">
      <header className="app-header">
        <div>
          <h1>VECTA</h1>
          <p className="app-subtitle">テンプレート管理 · サブタスクテンプレート</p>
        </div>
        <div className={`save-badge save-badge--${saveState}`} data-testid="save-state">{saveState}</div>
      </header>
      {notice !== null && (
        <div className="master-notice" role="alert" data-testid="template-notice">{notice}</div>
      )}
      <div className="template-body" data-testid="template-screen">
        <section className="master-section template-list-section">
          <h2 className="master-title">テンプレート</h2>
          <ul className="master-list">
            {templates.map((template) => (
              <li
                className={`template-list-row${template.id === selected?.id ? " template-list-row--active" : ""}`}
                key={template.id}
                data-testid="template-list-row"
              >
                <button
                  type="button"
                  className="template-select"
                  data-testid="template-select"
                  aria-pressed={template.id === selected?.id}
                  onClick={() => setSelectedId(template.id)}
                >
                  {template.name}
                </button>
                <input
                  className="master-input template-rename"
                  defaultValue={template.name}
                  disabled={!editable}
                  aria-label="テンプレート名"
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    if (name !== "" && name !== template.name) {
                      executeCommand({ type: "template.update", templateId: template.id, changes: { name } });
                    } else {
                      event.target.value = template.name;
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    else if (event.key === "Escape") {
                      event.currentTarget.value = template.name;
                      event.currentTarget.blur();
                    }
                  }}
                />
                <button
                  type="button"
                  className="master-delete"
                  data-testid="template-delete"
                  aria-label={`${template.name} を削除`}
                  disabled={!editable}
                  onClick={() => executeCommand({ type: "template.delete", templateId: template.id })}
                >
                  削除
                </button>
              </li>
            ))}
            {templates.length === 0 && <li className="master-empty">（未登録）</li>}
          </ul>
          <div className="master-add">
            <input
              className="master-input"
              placeholder="テンプレートを追加…"
              value={draft}
              disabled={!editable}
              aria-label="テンプレートを追加"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitAdd();
              }}
            />
            <button
              type="button"
              className="master-add-button"
              data-testid="template-add"
              disabled={!editable}
              onClick={commitAdd}
            >
              追加
            </button>
          </div>
        </section>
        <section className="master-section template-editor-section" data-testid="template-editor">
          {selected === null ? (
            <p className="master-empty">左のリストからテンプレートを選択してください。</p>
          ) : (
            <>
              <h2 className="master-title">{selected.name}</h2>
              <StepEditor
                steps={selected.subtasks}
                editable={editable}
                onChange={(steps) =>
                  executeCommand({
                    type: "template.update",
                    templateId: selected.id,
                    changes: { subtasks: steps },
                  })
                }
              />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
