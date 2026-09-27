# Spec: Composer 常用语（发送按钮空态点击面板 + 管理）

> 实现入口：`packages/ui/src/v4/ConversationComposer.tsx`（发送按钮 `submitControlNode`）、
> `packages/ui/src/v4/composer/composerQuickPhrases.ts`（存储）、
> `packages/ui/src/v4/composer/ComposerQuickPhrasesMenu.tsx`（面板）、
> `packages/ui/src/v4/composer/ComposerQuickPhrasesManageDialog.tsx`（管理弹窗）。
> 2026-09-27 按用户需求新增：发送按钮空输入时点击弹常用语面板，替代纯置灰。

## 1. 产品规则

- 发送按钮（`TID_V4_COMPOSER_SEND`）两种语义，按可提交内容切换：
  1. **有可提交内容**（文本 / 附件 / 代码评论 / 网页元素 / 会话选区 / 分享上下文，即 `hasDraftToSubmit`）：维持原发送语义不变（`type="submit"`，tooltip「发送/入队」，含全部准入守卫）。
  2. **无可提交内容且具备发送条件**（`!pending && routingAllowsSend && attachmentsReady && submissionReady`）：按钮不再置灰，点击弹出常用语面板（向上弹出、右对齐）；tooltip 显示「常用语」。不具备发送条件时维持置灰。
- 常用语面板：列出常用语（全局用户级，不按 workspace 隔离），点击一条短语 = **写入编辑器并立即走既有 `submit()` 链路发送**（`setText` → `updateText` → `submit`，含队列准入、遥测、失败保留草稿等全部既有语义），不是仅填充；面板底部「管理常用语」入口打开管理弹窗并关闭面板。空列表显示引导文案。
- 管理弹窗：输入框 + 添加（回车或按钮）、逐条删除、完成关闭。不做编辑与排序（删除后重加即可）；后续需要时再扩展。
- 常用语数据在多个 composer 实例（主 pane / 分屏 / 副屏）间通过模块级 store 订阅保持一致。

## 2. 状态所有者与不变量

- 常用语唯一所有者：`composerQuickPhrases.ts` 模块级 store（lazy 读 localStorage，写穿透持久化，`useSyncExternalStore` 订阅）。存储 key：`zcode:composer:quick-phrases`，结构为 `{id, text}[]`（`text` 存储前 trim，空串不入库）。
- 发送按钮的发送编排仍唯一归 `ConversationComposer.submit()`；常用语发送不建第二条发送路径，只注入文本后复用 `submit()`。
- 管理弹窗与面板的开关状态归各 composer 实例局部所有。

## 3. 失败语义

- localStorage 不可用（隐私模式 / 已禁用）：读写 try/catch，降级为内存态（本实例可用、不持久化），不报错。
- 常用语发送命中既有失败路径（provider 未就绪、admission 拒绝等）：与手输发送完全一致（pane-local 错误横幅、草稿保留在输入框），不新增兜底。

## 4. 验收场景

1. 空输入点击发送按钮：弹出常用语面板；点击一条短语后面板关闭、消息按既有链路发出并清空输入框。
2. 输入文字后按钮恢复原发送语义：点击直接发送，tooltip 为「发送」。
3. 面板底部点「管理常用语」：面板关闭、管理弹窗打开；输入并回车/点添加后列表即时新增且持久化（重开应用仍在）；点删除图标即移除。
4. 无常用语时：面板显示引导文案，管理入口仍可用。
5. busy（流式中）空输入：仍显示 Stop 控件，不出现常用语面板；模型未就绪等不可发送态按钮保持置灰。
