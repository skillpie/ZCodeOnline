import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ServerLayout } from "./paths.js";

// 受管安装标记（specs/web-tunnel.md 更新器 M4）：install.sh / install.ps1 安装完成时
// 写入 data root。daemon 侧据此区分"终端用户安装布局"与"仓库 dev 直跑"——所有权标记
// install.json 所有 daemon 都会写，无法用于该判定。标记缺失或损坏一律视为非受管安装
// （fail closed：不启用自动更新）。
const managedInstallSchema = z
  .object({
    product: z.literal("zcode-server"),
    managed: z.literal(true),
    installedAt: z.number().int().nonnegative(),
  })
  .strict();

export async function readManagedInstall(layout: ServerLayout): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(layout.managedInstallFile, "utf8");
  } catch {
    return false;
  }
  try {
    return managedInstallSchema.safeParse(JSON.parse(raw)).success;
  } catch {
    return false;
  }
}
