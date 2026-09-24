/**
 * 数据源配置持久化：{dataBaseDir}/.zcode/v2/data-sources/config.json。
 * Host 端唯一持久化所有者；原子写，坏文件/缺失一律回退默认值（不隔离，区别于 setting.json）。
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DataSourceConfig } from "@zcode/shared";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { getAppConfigDir } from "../paths.js";

const CONFIG_VERSION = 1;

export interface DataSourceConfigFile {
  version: number;
  activeId: string | null;
  dataSources: DataSourceConfig[];
}

function defaultConfigFile(): DataSourceConfigFile {
  return { version: CONFIG_VERSION, activeId: null, dataSources: [] };
}

export function getDataSourceDataDir(): string {
  return join(getAppConfigDir(), "data-sources");
}

export function getDataSourceConfigFile(): string {
  return join(getDataSourceDataDir(), "config.json");
}

export async function loadDataSourceConfigFile(): Promise<DataSourceConfigFile> {
  try {
    const raw = await readFile(getDataSourceConfigFile(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<DataSourceConfigFile> | null;
    if (!parsed || !Array.isArray(parsed.dataSources)) {
      return defaultConfigFile();
    }
    // activeId 指向不存在的源时视为未激活，避免悬挂引用
    const activeId = parsed.activeId;
    return {
      version: CONFIG_VERSION,
      activeId:
        typeof activeId === "string" && parsed.dataSources.some((item) => item.id === activeId)
          ? activeId
          : null,
      dataSources: parsed.dataSources,
    };
  } catch {
    return defaultConfigFile();
  }
}

export async function saveDataSourceConfigFile(
  file: Omit<DataSourceConfigFile, "version">,
): Promise<void> {
  await mkdir(getDataSourceDataDir(), { recursive: true });
  await atomicWriteText(
    getDataSourceConfigFile(),
    JSON.stringify({ ...file, version: CONFIG_VERSION }, null, 2),
  );
}
