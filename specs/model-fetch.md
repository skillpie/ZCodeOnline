# 供应商一键获取模型列表 Spec

## 背景

自定义供应商（以及所有 API Key 型供应商）在填完 API 地址 + API Key 后，
用户必须手工输入模型 ID，且不知道该填哪些。本能力允许从供应商接口
（OpenAI 兼容 `GET {base}/models`、Anthropic `GET {base}/v1/models`）
一键拉取可用模型 ID，在「添加模型」弹窗中下拉选择。
（移植自 skcode 同名能力，见其 `74e94e4`。）

## 设计决策

- 「选中模型后自动填写上下文/最大输出」**部分成立**：标准 `/models` 响应只有
  `id` 列表，不带上下文/输出大小；仅少数网关（OpenRouter `context_length`、
  vLLM `max_model_len` 等）附带。因此填充优先级为：
  1. 响应条目自带大小字段（识别 `context_length` / `context_window` /
     `max_model_len` / `max_output_tokens` / `max_completion_tokens`）；
  2. 已有的「智能配置」（`resolveModelConfig`，按模型 ID 匹配推荐规则库）——
     已知模型 ID 输入后本就会自动推荐；
  3. 都没有则留空，由用户手填。思考/视觉等模态能力 `/models` 不返回，
     维持手动勾选。
- 获取走 **main 进程直连**（避开 renderer CORS），复用 PlatformChannels IPC 通道模式。
- 拉取结果只在当前设置页内存中（不持久化），保存供应商配置的既有链路不变。

## 状态所有者

- 拉取结果 `fetchedModels`：InlineEditableProviderCard 组件内 useState；
  切换供应商卡片随组件 key 重置。不进 zustand、不广播。
- 添加弹窗内的选择候选 = `fetchedModels` 过滤掉已添加的 modelId。

## 接口

- `PlatformChannels.ProviderListModels`（`zcode:provider-list-models`）+
  `IPlatformService.providerListModels?`（desktop preload 桥接；web 端不提供
  该方法，UI 据此隐藏入口）。
- main 侧 `desktopProviderModels.ts`：按 apiFormat 拼 URL/头部
  （openai-\*/anthropic-messages），15s 超时；解析 `data[]`（兼容裸数组与
  `{models:[]}`），挑选可选大小字段为 `contextWindow` / `maxOutputTokens`，
  按 id 去重、上限 2000 条。凭据仅用于本次请求，不落日志。
- UI：`ProviderModelsSection` 标题行新增「获取模型列表」按钮（web 不可用时隐藏）；
  添加模型弹窗模型 ID 输入框旁出现候选下拉（`ProviderModelIdField`，按输入过滤、
  最多展示 50 条），选中即写入 ID，若上下文/最大输出为空且候选带大小则一并填入。

## 验收场景

1. 自定义 OpenAI 兼容供应商填好地址与 Key → 点「获取模型列表」→ 提示获取到
   N 个模型；打开「添加模型」，模型 ID 输入框出现候选，支持按输入过滤。
2. 选中候选：ID 写入；若该条目带大小字段且字段为空则自动填入；
   已知模型 ID 同时触发智能配置推荐。
3. Key 错误 / 地址不可达：按钮旁显示错误信息，不影响手填路径。
4. Anthropic 格式供应商同样可用（/v1/models + x-api-key 头）。
5. Web 端不渲染该按钮。
6. `pnpm --filter @zcode/desktop test` 覆盖解析与请求构造（去重、大小字段、
   路径/鉴权头、错误路径）。
