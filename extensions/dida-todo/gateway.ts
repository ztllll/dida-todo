import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DidaProject, DidaProjectData, DidaTask } from "./domain.js";
import type { DidaGateway } from "./repository.js";
import type { DidaComment } from "./acceptance.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;

function outputError(stderr: string, stdout: string): string {
  return (stderr || stdout || "dida CLI 执行失败").trim().slice(0, 4000);
}

export class DidaCliGateway implements DidaGateway {
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly command = "dida",
  ) {}

  async login(signal?: AbortSignal): Promise<string> {
    return this.exec(["auth", "login"], signal, 10 * 60_000);
  }

  async listProjects(signal?: AbortSignal): Promise<DidaProject[]> {
    return this.execJson(["project", "list", "--json"], signal);
  }

  async createProject(name: string, signal?: AbortSignal): Promise<DidaProject> {
    return this.execJson(["project", "create", "--name", name, "--view-mode", "list", "--kind", "TASK", "--json"], signal);
  }

  async getProjectData(projectId: string, signal?: AbortSignal): Promise<DidaProjectData> {
    const raw = await this.execJson<Partial<DidaProjectData> | null>(["project", "data", projectId, "--json"], signal);
    const data = raw && typeof raw === "object" ? raw : {};
    const project = data.project && typeof data.project === "object" ? data.project : undefined;
    return {
      project: {
        ...project,
        id: typeof project?.id === "string" && project.id ? project.id : projectId,
        name: typeof project?.name === "string" && project.name ? project.name : projectId,
      },
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      columns: Array.isArray(data.columns) ? data.columns : [],
    };
  }

  async getTask(projectId: string, taskId: string, signal?: AbortSignal): Promise<DidaTask> {
    return this.execJson(["task", "get", projectId, taskId, "--json"], signal);
  }

  async createTask(input: Record<string, unknown>, signal?: AbortSignal): Promise<DidaTask> {
    const args = [
      "task",
      "create",
      "--title",
      String(input.title),
      "--project",
      String(input.projectId),
      "--content",
      String(input.content ?? ""),
      "--tags",
      Array.isArray(input.tags) ? input.tags.join(",") : "pi-todo",
    ];
    if (input.items !== undefined) args.push("--items", JSON.stringify(input.items));
    if (input.desc !== undefined) args.push("--desc", String(input.desc));
    if (input.isAllDay === true) args.push("--all-day");
    if (input.startDate !== undefined) args.push("--start-date", String(input.startDate));
    if (input.dueDate !== undefined) args.push("--due-date", String(input.dueDate));
    if (input.timeZone !== undefined) args.push("--time-zone", String(input.timeZone));
    if (Array.isArray(input.reminders) && input.reminders.length) args.push("--reminders", input.reminders.join(","));
    if (input.repeatFlag !== undefined) args.push("--repeat", String(input.repeatFlag));
    if (input.priority !== undefined) args.push("--priority", String(input.priority));
    if (input.sortOrder !== undefined) args.push("--sort-order", String(input.sortOrder));
    args.push("--json");
    return this.execJson(args, signal);
  }

  async updateTask(taskId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<DidaTask> {
    const args = [
      "task",
      "update",
      taskId,
      "--id",
      String(input.id ?? taskId),
      "--project",
      String(input.projectId),
      "--title",
      String(input.title),
      "--content",
      String(input.content ?? ""),
      "--tags",
      Array.isArray(input.tags) ? input.tags.join(",") : "pi-todo",
      "--priority",
      String(input.priority ?? 0),
    ];
    if (input.items !== undefined) args.push("--items", JSON.stringify(input.items));
    if (input.desc !== undefined) args.push("--desc", String(input.desc));
    if (input.isAllDay === true) args.push("--all-day");
    if (input.startDate !== undefined) args.push("--start-date", String(input.startDate));
    if (input.dueDate !== undefined) args.push("--due-date", String(input.dueDate));
    if (input.timeZone !== undefined) args.push("--time-zone", String(input.timeZone));
    if (Array.isArray(input.reminders) && input.reminders.length) args.push("--reminders", input.reminders.join(","));
    if (input.repeatFlag !== undefined) args.push("--repeat", String(input.repeatFlag));
    if (input.sortOrder !== undefined) args.push("--sort-order", String(input.sortOrder));
    args.push("--json");
    return this.execJson(args, signal);
  }

  async completeTask(projectId: string, taskId: string, signal?: AbortSignal): Promise<void> {
    await this.exec(["task", "complete", projectId, taskId], signal);
  }

  async addTaskComment(projectId: string, taskId: string, title: string, signal?: AbortSignal): Promise<void> {
    await this.exec(["task", "comment", "add", projectId, taskId, "--title", title, "--json"], signal);
  }

  async getTaskComments(projectId: string, taskId: string, signal?: AbortSignal): Promise<DidaComment[]> {
    return this.execJson(["task", "comment", "list", projectId, taskId, "--json"], signal);
  }

  private async execJson<T>(args: string[], signal?: AbortSignal): Promise<T> {
    const stdout = await this.exec(args, signal);
    if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) throw new Error("dida CLI JSON 输出超过 1 MiB 限制");
    try {
      return JSON.parse(stdout) as T;
    } catch (error) {
      throw new Error(`无法解析 dida CLI JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async exec(args: string[], signal?: AbortSignal, timeout = 30_000): Promise<string> {
    const result = await this.pi.exec(this.command, args, { signal, timeout });
    if (result.code !== 0) throw new Error(outputError(result.stderr, result.stdout));
    return result.stdout.trim();
  }
}
