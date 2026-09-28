---
name: skillpie
description: >
  SkillPie 技能库 CLI 工具，支持发布、搜索、安装和更新技能。
  适用场景：
  (1) 用户要求提交一个本地技能目录
  (2) 用户要求将技能发布到技能库
  (3) 用户要求搜索或安装技能
  (4) 用户明确要求更新技能。
  触发词："发布技能"、"提交技能"、"上传技能"、"技能库提交"、"skillpie submit"、"发布到SkillPie"、"打包技能目录"、"上传到技能库"、"搜索技能"、"查找技能"、"安装技能"、"更新技能"。
title: 技能派
category: 通用技能
---

# SkillPie CLI

## 核心功能

### 1. 发布技能

```bash
cd <SKILL_DIR>
node scripts/cli.js submit /absolute/path/to/skill
```

**重要**：
- CLI 会在提交前自动检查 skillpie 技能是否有新版本，如果有则先更新，然后再执行提交流程
- 使用 AppKey 进行认证（通过 Bearer Token）
- 首次发布前需要配置 AppKey，后续发布自动使用已保存的 AppKey

**首次发布流程**：
1. 如果用户未配置 AppKey，引导用户前往 https://skillpie.cn → 创作中心 → 个人信息
2. 用户生成并复制 AppKey 后，帮用户执行：`node scripts/cli.js config --app-key <用户的AppKey>`
3. 配置完成后，直接使用 submit 命令发布技能

**后续发布**：直接使用 submit 命令，无需再次配置

### 2. 搜索技能

当用户说“搜索技能”、“查找技能”或提到某个技能关键词时：

```bash
cd <SKILL_DIR>
node scripts/cli.js search "关键词" --limit 10
```

CLI 会：
- 在 skillpie.cn 上搜索匹配的技能
- 显示技能名称、描述、分类、版本、下载量、点赞数等信息
- 提供安装命令提示

### 3. 安装技能

当用户要求安装某个技能时：

```bash
cd <SKILL_DIR>
node scripts/cli.js install <normalizedName>
```

CLI 会：
- 从 skillpie.cn 下载技能包
- 解压到当前 Agent 的技能目录（如 `.agents/skills/<normalizedName>/`，项目内装入项目级技能目录，否则装入用户级 `~/.agents/skills/`）
- 安装完成后技能立即可用

### 4. 手动更新 skillpie 技能

```bash
cd <SKILL_DIR>
node scripts/cli.js update
```

检查并更新 skillpie 技能到最新版本。

## 使用前提

- 可以访问 SkillPie 服务地址 https://skillpie.cn/
- 当前工作目录下存在 `scripts/cli.js`
- 待提交的技能目录至少包含 `SKILL.md`

## 流程一：提交技能包

### 最简命令

```bash
cd <SKILL_DIR>
node scripts/cli.js submit /absolute/path/to/skill-dir
```

CLI 会按以下顺序处理：

1. **检查更新**：自动检查并更新 skillpie 技能（如有新版本）
2. **校验目录**：校验技能目录结构
3. **读取元数据**：读取 manifest.json 或使用命令参数
4. **打包技能**：打包整个技能目录为 .zip（限制 10MB）
5. **验证身份**：检查 AppKey 配置（未配置会提示）
6. **直接上传**：上传到后端服务器
7. **发布上线**：发布技能元数据，立即可用

### 元数据来源

CLI 会按以下优先级读取元数据：

**1. SKILL.md frontmatter（推荐，优先级最高）**

在 SKILL.md 文件顶部添加 YAML frontmatter：

```yaml
---
name: ai-stock
description: A股主板B1量化选股工具，基于KDJ、趋势线、N型结构等多维度技术评分。
title: AI选股
category: 学术研究
---
```

- `name`: 技能唯一标识，用于生成 normalizedName（必填）
- `description`: 技能简短描述（必填）
- `title`: 技能显示名称（可选，没有则使用name）
- `category`: 技能分类（可选值：通用技能/开发工具/办公效率/学术研究/内容创作，没有则使用通用技能）

**2. manifest.json（可选，优先级次之）**

如果技能目录包含 `manifest.json`，CLI 会读取以下字段作为备用：

- `name`: 技能显示名称（如果 frontmatter 没有 title）
- `normalizedName`: 技能唯一标识（如果 frontmatter 没有 name）
- `category`: 技能分类
- `description`: 技能描述

**3. 命令参数（最低优先级）**

如果以上两种方式都没有提供完整元数据，可以通过命令参数补齐：

```bash
cd <SKILL_DIR>
node scripts/cli.js submit /absolute/path/to/skill-dir \
  --title "AI选股" \
  --name "ai-stock" \
  --category "学术研究" \
  --description "A股主板B1量化选股工具，基于KDJ、趋势线、N型结构等多维度技术评分。"
```

### 技能目录要求

待提交的技能目录至少需要包含：

- `SKILL.md`（必须包含 frontmatter 元数据）

可选提供：

- `manifest.json`（作为元数据备用来源）
- `README.md`（如果存在且非空，内容将自动同步为技能的技能说明）

建议使用绝对路径提交技能目录，避免在不同工作目录下误传目标目录。

## 流程二：搜索和安装技能

### 搜索技能

```bash
cd <SKILL_DIR>
node scripts/cli.js search "关键词" --limit 10
```

示例输出：

```
找到以下技能：

1. SkillPie (skillpie)
   描述: SkillPie CLI tool,用于将技能打包发布到SkillPie
   分类: 通用技能
   版本: v2 | 下载: 156 | 点赞: 23
   作者: SkillPie Team

安装命令: skillpie install <normalizedName>
```

### 安装技能

```bash
cd <SKILL_DIR>
node scripts/cli.js install skillpie
```

安装完成后，技能会出现在当前 Agent 的技能目录中。

## AppKey 配置

### 获取 AppKey

当用户需要配置 AppKey 时：
1. 引导用户打开 https://skillpie.cn 并登录
2. 引导用户进入 创作中心 → 个人信息
3. 引导用户找到 "AppKey" 项并复制
4. 用户提供了 AppKey 后，执行配置命令

### 配置 AppKey

```bash
cd <SKILL_DIR>
node scripts/cli.js config --app-key <用户提供的 AppKey>
```

**注意**：AppKey 格式为 `sk_` 开头的 66 位字符串

### 查看当前配置

```bash
cd <SKILL_DIR>
node scripts/cli.js config
```

### Agent 操作流程

当用户首次发布技能时：
1. 执行 submit 命令
2. 如果提示 "未配置 AppKey"，告知用户需要获取 AppKey
3. 引导用户前往网站复制 AppKey
4. 用户提供 AppKey 后，执行 `config --app-key` 命令
5. 配置成功后，重新执行 submit 命令

### 配置存储

- AppKey 保存在：`~/.config/skillpie/config.json`
- AppKey 用于 CLI 工具身份验证，请妥善保管，不要泄露给他人
- 如需更换 AppKey，可在个人信息页面重新生成，然后更新本地配置

## 常用命令

```bash
# 配置 AppKey（首次使用前）
cd <SKILL_DIR>
node scripts/cli.js config --app-key sk_xxxxxxxxxxxxxxxx

# 查看当前配置
node scripts/cli.js config

# 发布技能（自动检查更新）
node scripts/cli.js submit /absolute/path/to/skill-dir

# 搜索技能
node scripts/cli.js search "关键词"

# 安装技能
node scripts/cli.js install <normalizedName>

# 更新 skillpie 技能
node scripts/cli.js update

# 帮助
node scripts/cli.js --help
```

## 原则

- 中间出现无法处理的错误，请将重要信息告知用户
- 执行结束之后，进行核心信息总结
- 发布技能前自动检查并更新 skillpie 技能，确保使用最新版本
- **技能标识唯一性**：技能标识（name）必须全局唯一，如果发布时提示标识冲突，需要修改 SKILL.md 中的 name 字段为其他唯一标识

## 常见问题

- 首次发布技能时需要配置 AppKey，引导用户前往 https://skillpie.cn → 创作中心 → 个人信息 获取
- AppKey 配置命令：`node scripts/cli.js config --app-key <AppKey>`
- AppKey 保存在 `~/.config/skillpie/config.json`
- 技能包大小限制为 10MB，超过限制会上传失败
- 搜索技能时，会匹配技能名称、描述和 SKILL.md 内容中的关键词
- AppKey 是敏感信息，提醒用户妥善保管
- **技能标识冲突**：如果发布时提示“技能标识 xxx 已被其他用户发布”，需要用户手动修改 SKILL.md 中的 name 字段为唯一标识后重试

**注意**：
- **不同 Agent 的技能目录不同**，`<SKILL_DIR>` 表示`skillpie`技能安装目录,实际使用时替换为技能所在路径