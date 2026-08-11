import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DidaTodoConfig } from "./domain.js";
import type { DidaCliGateway } from "./gateway.js";
import { bindExistingProject, ensureProjectBinding, isDidaAuthenticationError } from "./provisioning.js";

const ACTIONS = ["login", "auto", "bind"] as const;

interface SetupContext {
  cwd: string;
  tmuxTarget?: string;
}

export function registerDidaSetupTool(
  pi: ExtensionAPI,
  gateway: DidaCliGateway,
  config: DidaTodoConfig,
  getContext: (sessionId: string) => SetupContext | undefined,
  activate: (ctx: ExtensionContext, binding: import("./domain.js").ProjectBinding) => Promise<void>,
  configPath?: string,
): void {
  pi.registerTool({
    name: "dida_todo_setup",
    label: "Dida Todo Setup",
    description: "Log in with the bundled Dida CLI, auto-provision this cwd/tmux target, or bind an existing project by ID/exact name.",
    promptSnippet: "Auto-provision or rebind the Dida project for this Pi target",
    promptGuidelines: [
      "If dida-todo reports that Dida CLI is not logged in, tell the user to run the bundled dida auth login command, then call this tool with action auto.",
      "Use bind only when the user explicitly asks to change the project or duplicate names require a projectId.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      projectId: Type.Optional(Type.String()),
      projectName: Type.Optional(Type.String()),
    }),
    async execute(_id, rawParams, signal, _update, ctx) {
      const params = rawParams as { action: (typeof ACTIONS)[number]; projectId?: string; projectName?: string };
      const sessionId = ctx.sessionManager.getSessionId();
      const current = getContext(sessionId) ?? { cwd: ctx.cwd };
      try {
        if (params.action === "login") {
          await gateway.login(signal);
          const result = await ensureProjectBinding({ gateway, cwd: current.cwd, tmuxTarget: current.tmuxTarget, configPath, signal });
          config.bindings = result.config.bindings;
          await activate(ctx, result.binding);
          return {
            content: [{ type: "text", text: `Dida CLI login completed. ${result.createdProject ? "Created and bound" : "Bound"} project: ${result.project.name} (${result.project.id}).` }],
            details: { action: params.action, project: result.project, binding: result.binding, createdProject: result.createdProject },
          };
        }
        const result = params.action === "bind"
          ? await bindExistingProject({
            gateway,
            cwd: current.cwd,
            tmuxTarget: current.tmuxTarget,
            projectId: params.projectId,
            projectName: params.projectName,
            configPath,
            signal,
          })
          : await ensureProjectBinding({ gateway, cwd: current.cwd, tmuxTarget: current.tmuxTarget, configPath, signal });
        config.bindings = result.config.bindings;
        await activate(ctx, result.binding);
        return {
          content: [{ type: "text", text: `${result.createdProject ? "Created and bound" : "Bound"} Dida project: ${result.project.name} (${result.project.id}). The binding is active immediately.` }],
          details: { action: params.action, project: result.project, binding: result.binding, createdProject: result.createdProject },
        };
      } catch (error) {
        if (isDidaAuthenticationError(error)) {
          throw new Error("Dida CLI 尚未登录。dida-todo 已内置 @suibiji/dida-cli；请进入 Pi 安装的 dida-todo Git 包目录运行 ./node_modules/.bin/dida auth login，登录后执行 /reload。无需另装全局 dida 命令。");
        }
        throw error;
      }
    },
  });
}
