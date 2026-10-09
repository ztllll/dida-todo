/** 宿主无关的工具返回值：Pi 的 AgentToolResult 结构子集，dsh 适配层取其 text。 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: any;
}
