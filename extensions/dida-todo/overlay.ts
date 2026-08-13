import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { Task } from "./domain.js";

const WIDGET_KEY = "dida-todos";

export function overlayHeadingTitle(workTitle: string | undefined, tasks: Task[]): string | undefined {
  const title = workTitle?.trim();
  if (!title) return undefined;
  const visible = tasks.filter((task) => task.status !== "deleted");
  if (visible.some((task) => task.subject.trim() === title)) return undefined;
  return title;
}

function taskLine(task: Task, theme: Theme): string {
  const glyph =
    task.status === "completed"
      ? theme.fg("success", "✓")
      : task.status === "in_progress"
        ? theme.fg("warning", "◐")
        : task.status === "deleted"
          ? theme.fg("error", "✗")
          : theme.fg("dim", "○");
  let subject = theme.fg(task.status === "in_progress" ? "accent" : task.status === "completed" ? "muted" : "text", task.subject);
  if (task.status === "completed" || task.status === "deleted") subject = theme.strikethrough(subject);
  let line = `${glyph} ${theme.fg("dim", `#${task.id}`)} ${subject}`;
  if (task.status === "in_progress" && task.activeForm) line += ` ${theme.fg("muted", `(${task.activeForm})`)}`;
  if (task.blockedBy?.length) line += ` ${theme.fg("muted", `⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
  return line;
}

export class TodoOverlay {
  private ui?: ExtensionUIContext;
  private tui?: TUI;
  private registered = false;
  private collapsed = false;

  constructor(
    private readonly getTasks: () => Task[],
    private readonly getWorkId: () => string | undefined,
    private readonly getWorkTitle: () => string | undefined,
    private readonly getMaxLines: () => number,
    private readonly collapseKey: string,
  ) {}

  setUI(ui: ExtensionUIContext): void {
    if (this.ui !== ui) {
      this.ui = ui;
      this.registered = false;
      this.tui = undefined;
    }
  }

  update(resetCompleted = false): void {
    if (!this.ui) return;
    void resetCompleted;
    const tasks = this.visibleTasks();
    if (!tasks.length) {
      if (this.registered) this.ui.setWidget(WIDGET_KEY, undefined);
      this.registered = false;
      this.tui = undefined;
      return;
    }
    if (!this.registered) {
      this.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return { render: (width) => this.render(theme, width), invalidate: () => undefined };
        },
        { placement: "aboveEditor" },
      );
      this.registered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
    this.tui?.requestRender(true);
  }

  dispose(): void {
    this.ui?.setWidget(WIDGET_KEY, undefined);
    this.ui = undefined;
    this.tui = undefined;
    this.registered = false;
    this.collapsed = false;
  }

  isRegistered(): boolean {
    return this.registered;
  }

  private visibleTasks(): Task[] {
    return this.getTasks().filter((task) => task.status !== "deleted");
  }

  private render(theme: Theme, width: number): string[] {
    const tasks = this.visibleTasks();
    if (!tasks.length) return [];
    const allTasks = this.getTasks().filter((task) => task.status !== "deleted");
    const completed = allTasks.filter((task) => task.status === "completed").length;
    const active = allTasks.some((task) => task.status === "pending" || task.status === "in_progress");
    const workTitle = overlayHeadingTitle(this.getWorkTitle(), allTasks);
    const headingText = `${workTitle ? `${workTitle} · ` : ""}Todos (${completed}/${allTasks.length})`;
    const heading = `${theme.fg(active ? "accent" : "dim", active ? "●" : "○")} ${theme.fg(active ? "accent" : "dim", headingText)}`;
    const truncate = (line: string) => truncateToWidth(line, width, "…");
    if (this.collapsed) return [truncate(heading), truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", `${this.collapseKey} 展开`)}`), ""];

    const budget = Math.max(2, this.getMaxLines()) - 1;
    const unfinished = tasks.filter((task) => task.status !== "completed");
    const completedTasks = tasks.filter((task) => task.status === "completed");
    const ordered = [...unfinished, ...completedTasks];
    const visible = ordered.slice(0, budget);
    const lines = [truncate(heading)];
    visible.forEach((task, index) => {
      const prefix = index === visible.length - 1 && visible.length === ordered.length ? "└─" : "├─";
      lines.push(truncate(`${theme.fg("dim", prefix)} ${taskLine(task, theme)}`));
    });
    if (ordered.length > visible.length) lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${ordered.length - visible.length} more`)}`));
    lines.push("");
    return lines;
  }
}
