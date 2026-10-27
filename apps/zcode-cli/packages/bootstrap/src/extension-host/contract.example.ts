import type { ExtensionSetup, ExtensionToolDefinition } from "./contract.js";

/**
 * 最小可用扩展示例：注册一个免实现的只读工具 + 一个 SessionStart 观察者。
 * 放在 `~/.zcode/extensions/hello.ts` 即生效（CONTRACT.md「Trust model」）。
 */
export const exampleLookupTool: ExtensionToolDefinition = {
  name: "myext_lookup",
  description: "Look up a fact from the extension's local table",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Lookup key" },
    },
    required: ["key"],
  },
  readOnly: true,
  async execute(input) {
    const key = (input as { key?: string }).key ?? "";
    return { key, value: `value-for-${key}` };
  },
};

export const exampleExtensionSetup: ExtensionSetup = (api) => {
  api.tool(exampleLookupTool);
  api.on("SessionStart", async () => {
    api.log.info("hello extension loaded");
  });
};
