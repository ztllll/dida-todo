import { Type } from "typebox";

// 与 @earendil-works/pi-ai 的 StringEnum 等价；本地实现使核心模块不依赖 Pi 运行时，dsh 打包可复用。
export function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}
