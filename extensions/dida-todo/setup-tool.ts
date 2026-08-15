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
      "If dida-todo reports that Dida CLI is not logged in, call this tool with action login. Login automatically provisions, persists, and activates the current project; do not ask the user to find the package directory or run a second setup command.",
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
            content: [{ type: "text", text: `滴答登录完成，清单“${result.project.name}”已${result.createdProject ? "创建并" : ""}绑定且立即生效。现在可直接口述任务或创建 Todo，无需 /reload 或再次配置。` }],
            details: { action: params.action, project: result.project, binding: result.binding, createdProject: result.createdProject, ready: true },
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
          throw new Error("Dida CLI 尚未登录。请直接告诉 LLM“登录滴答”，由 dida_todo_setup login 打开浏览器授权并在成功后立即创建或复用清单、持久绑定并激活当前会话；无需另装全局 dida、寻找包目录、执行第二次配置或 /reload。");
        }
        throw error;
      }
    },
  });
}
