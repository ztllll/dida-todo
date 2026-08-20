import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DidaTodoConfig } from "./domain.js";
import type { DidaCliGateway } from "./gateway.js";
import { bindExistingProject, isDidaAuthenticationError, provisionPromptedProject } from "./provisioning.js";

const ACTIONS = ["login", "bind"] as const;

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
    description: "Log in with the bundled Dida CLI, then prompt for a Dida project name to bind or create; bind an existing project by ID/exact name when explicitly requested.",
    promptSnippet: "Bind or create the user-named Dida project for this Pi target",
    promptGuidelines: [
      "If dida-todo reports that Dida CLI is not logged in, call dida_todo_setup with action login. After login, dida_todo_setup must prompt the user for a Dida project name; it may bind a unique matching project or create only the exact name the user enters.",
      "Use dida_todo_setup bind only when the user explicitly asks to change the project or duplicate names require a projectId.",
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
          const result = await provisionPromptedProject({
            gateway,
            cwd: current.cwd,
            tmuxTarget: current.tmuxTarget,
            configPath,
            signal,
            prompt: () => ctx.ui.input("绑定滴答分组", "请输入分组名称：同名分组会绑定，不存在则按此名称创建；留空则跳过。"),
          });
          if (!result) {
            return { content: [{ type: "text", text: "滴答登录完成，但尚未绑定分组；下次启动或再次登录时输入分组名称即可绑定或创建。" }], details: { action: params.action, ready: false } };
          }
          config.bindings = result.config.bindings;
          await activate(ctx, result.binding);
          return {
            content: [{ type: "text", text: `滴答登录完成，清单“${result.project.name}”已${result.createdProject ? "创建并" : ""}绑定且立即生效。` }],
            details: { action: params.action, project: result.project, binding: result.binding, createdProject: result.createdProject, ready: true },
          };
        }
        const result = await bindExistingProject({
          gateway,
          cwd: current.cwd,
          tmuxTarget: current.tmuxTarget,
          projectId: params.projectId,
          projectName: params.projectName,
          configPath,
          signal,
        });
        config.bindings = result.config.bindings;
        await activate(ctx, result.binding);
        return {
          content: [{ type: "text", text: `已绑定滴答清单：${result.project.name}` }],
          details: { action: params.action, project: result.project, binding: result.binding, createdProject: false },
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
