import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyProjectCommand,
  type ProjectCommand,
  type ProjectMember,
  type ProjectState,
} from "@vecta/application";
import { createDemoProject } from "./demo-project";
import { ProjectApiError, type ProjectApiClient } from "./project-api-client";
import { TemplateSection } from "./TemplateSection";

// The master edit screen (Design 0003 §E-2 / §E-1): 工程 / プロダクト / メンバー /
// サブタスクテンプレート masters. 工程 and プロダクト are name-only lists (add /
// rename / delete); メンバー reuses the existing member fields; サブタスクテンプレート
// reuses the shared TemplateSection. Every change dispatches the same project
// command through the same API client the grid uses, so the screens stay in sync
// via the server (the single source of truth in connected mode).

type SaveState = "preview" | "loading" | "saved" | "saving" | "error";

// Preview (dev/demo only): a small in-memory demo so the masters and members are
// populated without a backend. Kept light so the whole-project validation that
// runs on every edit stays snappy.
function demoMasterProject(): ProjectState {
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
  nextTaskSeq: 1,
};

/** A name-only master list (工程 / プロダクト): add / rename / delete. */
function MasterList({
  title,
  addLabel,
  items,
  editable,
  onAdd,
  onRename,
  onDelete,
}: {
  readonly title: string;
  readonly addLabel: string;
  readonly items: readonly { readonly id: string; readonly name: string; readonly sortOrder: number }[];
  readonly editable: boolean;
  readonly onAdd: (name: string) => void;
  readonly onRename: (id: string, name: string) => void;
  readonly onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const ordered = [...items].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
  );
  const commitAdd = () => {
    const name = draft.trim();
    if (name === "") return;
    onAdd(name);
    setDraft("");
  };
  return (
    <section className="master-section" data-testid={`master-section-${title}`}>
      <h2 className="master-title">{title}</h2>
      <ul className="master-list">
        {ordered.map((item) => (
          <li className="master-row" key={item.id} data-testid="master-row">
            <input
              className="master-input"
              defaultValue={item.name}
              disabled={!editable}
              aria-label={`${title} 名`}
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (name !== "" && name !== item.name) onRename(item.id, name);
                else event.target.value = item.name;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                else if (event.key === "Escape") {
                  event.currentTarget.value = item.name;
                  event.currentTarget.blur();
                }
              }}
            />
            <button
              type="button"
              className="master-delete"
              data-testid="master-delete"
              aria-label={`${item.name} を削除`}
              disabled={!editable}
              onClick={() => onDelete(item.id)}
            >
              削除
            </button>
          </li>
        ))}
        {ordered.length === 0 && <li className="master-empty">（未登録）</li>}
      </ul>
      <div className="master-add">
        <input
          className="master-input"
          placeholder={addLabel}
          value={draft}
          disabled={!editable}
          aria-label={addLabel}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitAdd();
          }}
        />
        <button
          type="button"
          className="master-add-button"
          data-testid={`master-add-${title}`}
          disabled={!editable}
          onClick={commitAdd}
        >
          追加
        </button>
      </div>
    </section>
  );
}

/** The メンバー master: name, calendar, and daily capacity (hours). */
function MemberList({
  members,
  calendars,
  defaultCalendarId,
  editable,
  onAdd,
  onUpdate,
  onDelete,
}: {
  readonly members: readonly ProjectMember[];
  readonly calendars: readonly { readonly id: string; readonly name: string }[];
  readonly defaultCalendarId: string;
  readonly editable: boolean;
  readonly onAdd: (member: ProjectMember) => void;
  readonly onUpdate: (memberId: string, changes: Partial<Omit<ProjectMember, "id">>) => void;
  readonly onDelete: (memberId: string) => void;
}) {
  const [name, setName] = useState("");
  const commitAdd = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    onAdd({
      id: crypto.randomUUID(),
      name: trimmed,
      calendarId: defaultCalendarId,
      dailyCapacityMinutes: 480,
    });
    setName("");
  };
  return (
    <section className="master-section" data-testid="master-section-member">
      <h2 className="master-title">メンバー</h2>
      <ul className="master-list">
        {members.map((member) => (
          <li className="master-row master-row--member" key={member.id} data-testid="member-row">
            <input
              className="master-input"
              defaultValue={member.name}
              disabled={!editable}
              aria-label="メンバー名"
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value !== "" && value !== member.name) onUpdate(member.id, { name: value });
                else event.target.value = member.name;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <select
              className="master-input master-input--calendar"
              value={member.calendarId}
              disabled={!editable}
              aria-label="稼働カレンダー"
              onChange={(event) => onUpdate(member.id, { calendarId: event.target.value })}
            >
              {calendars.map((calendar) => (
                <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
              ))}
            </select>
            <input
              className="master-input master-input--capacity"
              type="number"
              min={1}
              max={24}
              step={0.5}
              defaultValue={(member.dailyCapacityMinutes ?? 480) / 60}
              disabled={!editable}
              aria-label="日次キャパシティ(時間)"
              onBlur={(event) => {
                const hours = Number(event.target.value);
                const minutes = Math.round(hours * 60);
                if (Number.isFinite(hours) && minutes >= 1 && minutes <= 1_440) {
                  if (minutes !== member.dailyCapacityMinutes) {
                    onUpdate(member.id, { dailyCapacityMinutes: minutes });
                  }
                } else {
                  event.target.value = String((member.dailyCapacityMinutes ?? 480) / 60);
                }
              }}
            />
            <span className="master-unit">h/日</span>
            <button
              type="button"
              className="master-delete"
              data-testid="member-delete"
              aria-label={`${member.name} を削除`}
              disabled={!editable}
              onClick={() => onDelete(member.id)}
            >
              削除
            </button>
          </li>
        ))}
        {members.length === 0 && <li className="master-empty">（未登録）</li>}
      </ul>
      <div className="master-add">
        <input
          className="master-input"
          placeholder="メンバーを追加…"
          value={name}
          disabled={!editable}
          aria-label="メンバーを追加"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitAdd();
          }}
        />
        <button
          type="button"
          className="master-add-button"
          data-testid="master-add-member"
          disabled={!editable}
          onClick={commitAdd}
        >
          追加
        </button>
      </div>
    </section>
  );
}

export function MasterScreen({ client }: { readonly client?: ProjectApiClient }) {
  const [project, setProject] = useState<ProjectState>(() =>
    client === undefined ? demoMasterProject() : EMPTY_PROJECT,
  );
  const [revision, setRevision] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(client === undefined ? "preview" : "loading");
  const [notice, setNotice] = useState<string | null>(null);
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

  // Optimistic apply → (connected) save → reload, mirroring the grid's write path
  // but without a derived-column recompute (masters carry no derived values).
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
              setNotice("Saved, but the masters could not be refreshed. Reload to retrieve them.");
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
  const nextSortOrder = (items: readonly { readonly sortOrder: number }[]): number =>
    items.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;

  return (
    <div className="app-shell master-shell">
      <header className="app-header">
        <p className="app-subtitle">マスタ管理 · 工程 / プロダクト / メンバー / サブタスクテンプレート</p>
        <div className={`save-badge save-badge--${saveState}`} data-testid="save-state">{saveState}</div>
      </header>
      {notice !== null && (
        <div className="master-notice" role="alert" data-testid="master-notice">{notice}</div>
      )}
      <div className="master-body" data-testid="master-screen">
        <div className="master-grid">
          <MasterList
            title="工程"
            addLabel="工程を追加…"
            items={project.processes}
            editable={editable}
            onAdd={(name) =>
              executeCommand({
                type: "process.add",
                process: { id: crypto.randomUUID(), name, sortOrder: nextSortOrder(project.processes) },
              })
            }
            onRename={(id, name) => executeCommand({ type: "process.update", processId: id, changes: { name } })}
            onDelete={(id) => executeCommand({ type: "process.delete", processId: id })}
          />
          <MasterList
            title="プロダクト"
            addLabel="プロダクトを追加…"
            items={project.products}
            editable={editable}
            onAdd={(name) =>
              executeCommand({
                type: "product.add",
                product: { id: crypto.randomUUID(), name, sortOrder: nextSortOrder(project.products) },
              })
            }
            onRename={(id, name) => executeCommand({ type: "product.update", productId: id, changes: { name } })}
            onDelete={(id) => executeCommand({ type: "product.delete", productId: id })}
          />
          <MemberList
            members={project.members}
            calendars={project.calendars}
            defaultCalendarId={project.defaultCalendarId}
            editable={editable}
            onAdd={(member) => executeCommand({ type: "member.add", member })}
            onUpdate={(memberId, changes) => executeCommand({ type: "member.update", memberId, changes })}
            onDelete={(memberId) => executeCommand({ type: "member.delete", memberId })}
          />
        </div>
        <TemplateSection
          templates={project.templates}
          editable={editable}
          executeCommand={executeCommand}
        />
      </div>
    </div>
  );
}
