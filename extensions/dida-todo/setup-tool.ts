import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { DidaTodoConfig } from "./domain.js";
import type { DidaCliGateway } from "./gateway.js";
import { bindExistingProject, ensureProjectBinding, isDidaAuthenticationError } from "./provisioning.js";
import type { ProvisioningNamespace } from "./provisioning-identity.js";

const ACTIONS = ["login", "auto", "bind"] as const;

interface SetupContext {
  cwd: string;
  tmuxTarget?: string;
  namespace?: ProvisioningNamespace;
}

export function registerDidaSetupTool(
  pi: ExtensionAPI,
  gateway: DidaCliGateway,
  config: DidaTodoConfig,
  getContext: (sessionId: string) => SetupContext | undefined,
  activate: (ctx: ExtensionContext, binding: import("./domain.js").ProjectBinding) => Promise<void>,
  configPath: string | undefined,
  isInteractiveSession: (sessionId: string) => boolean,
): void {
  const Type = pi.typebox.Type;
  const Params = Type.Object({
    action: Type.Union(ACTIONS.map((action) => Type.Literal(action))),
    projectId: Type.Optional(Type.String()),
    projectName: Type.Optional(Type.String()),
  });
  pi.registerTool({
    name: "dida_todo_setup",
    label: "Dida Todo Setup",
    description: "Log in with the bundled Dida CLI, auto-provision this cwd/tmux target, or bind an existing project by ID/exact name.",
    defaultInactive: true,
    loadMode: "essential",
    approval: "exec",
    parameters: Params,
    async execute(_id, rawParams, signal, _update, ctx) {
      const params = rawParams as { action: (typeof ACTIONS)[number]; projectId?: string; projectName?: string };
      const sessionId = ctx.sessionManager.getSessionId();
      if (!ctx.hasUI || !isInteractiveSession(sessionId)) {
        throw new Error("dida_todo_setup 只能在已激活的 OMP Interactive/TUI 主会话中执行。");
      }
      const current = getContext(sessionId) ?? { cwd: ctx.cwd };
      try {
        if (params.action === "login") {
          await gateway.login(signal);
          const result = await ensureProjectBinding({ gateway, cwd: current.cwd, tmuxTarget: current.tmuxTarget, namespace: current.namespace, configPath, signal });
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
            namespace: current.namespace,
            projectId: params.projectId,
            projectName: params.projectName,
            configPath,
            signal,
          })
          : await ensureProjectBinding({ gateway, cwd: current.cwd, tmuxTarget: current.tmuxTarget, namespace: current.namespace, configPath, signal });
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
