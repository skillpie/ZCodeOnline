// 浏览器侧远程码存储（specs/web-tunnel.md §5.9）：两条 localStorage 数据的唯一读写路径。
// - `zcode-assist-code`：当前生效的远程码（"码即凭证"的连接目标；打开带码链接后到优先，
//   弹窗「切换」也会改写它）。
// - `zcode-assist-machines`：用过的远程链接列表（码 + 展示名，默认名 = 码），
//   远程控制弹窗据此渲染列表，本机条目由回环发现端点的权威码合并置顶。
// 放在 ui 包供远程控制弹窗与 web 入口共用；web 包经 `@zcode/ui/assist-machine-store` 引用。
import { normalizeAssistCode } from "@zcode/shared";

const ACTIVE_CODE_STORAGE_KEY = "zcode-assist-code";
const MACHINES_STORAGE_KEY = "zcode-assist-machines";

export function loadStoredAssistCode(): string | null {
  try {
    return normalizeAssistCode(localStorage.getItem(ACTIVE_CODE_STORAGE_KEY) ?? "");
  } catch {
    return null;
  }
}

/** 后到优先：多次使用不同远程码链接时，最后一次传入的码覆盖之前的。 */
export function saveStoredAssistCode(code: string): void {
  const normalized = normalizeAssistCode(code);
  if (!normalized) return;
  localStorage.setItem(ACTIVE_CODE_STORAGE_KEY, normalized);
}

export function clearStoredAssistCode(): void {
  localStorage.removeItem(ACTIVE_CODE_STORAGE_KEY);
}

export interface AssistMachine {
  code: string;
  /** 展示名；默认「<远程码>的ZCode」，用户可在远程控制弹窗里改名。 */
  name: string;
}

/** 条目默认名：码本身没有辨识度，补「的ZCode」后缀；改名清空时也回退到它。 */
export function defaultAssistMachineName(code: string): string {
  return `${code}的ZCode`;
}

export function loadAssistMachines(): AssistMachine[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MACHINES_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const machines: AssistMachine[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const code = normalizeAssistCode(String((item as { code?: unknown }).code ?? ""));
      if (!code) continue;
      const name = (item as { name?: unknown }).name;
      machines.push({
        code,
        name:
          typeof name === "string" && name.trim() ? name.trim() : defaultAssistMachineName(code),
      });
    }
    return machines;
  } catch {
    return [];
  }
}

function saveAssistMachines(machines: AssistMachine[]): void {
  localStorage.setItem(MACHINES_STORAGE_KEY, JSON.stringify(machines));
}

/**
 * 打开带码链接 / 发现本机码时登记：新码以默认名（缺省「<码>的ZCode」）入列，已有码
 * 保留名称；仅当旧名称仍是码默认名（未被用户改过）时才升级为传入的 defaultName
 * （本机条目用它把默认名定为「我的ZCode」）。
 */
export function upsertAssistMachine(code: string, defaultName?: string): AssistMachine | null {
  const normalized = normalizeAssistCode(code);
  if (!normalized) return null;
  const machines = loadAssistMachines();
  const existing = machines.find((machine) => machine.code === normalized);
  if (existing) {
    const nextDefault = defaultName?.trim();
    if (nextDefault && existing.name === defaultAssistMachineName(normalized)) {
      existing.name = nextDefault;
      saveAssistMachines(machines);
    }
    return existing;
  }
  const machine: AssistMachine = {
    code: normalized,
    name: defaultName?.trim() || defaultAssistMachineName(normalized),
  };
  machines.push(machine);
  saveAssistMachines(machines);
  return machine;
}

/** 重命名条目；空/空白名回退为默认名。条目不存在时静默忽略。 */
export function renameAssistMachine(code: string, name: string): AssistMachine[] {
  const normalized = normalizeAssistCode(code);
  if (!normalized) return loadAssistMachines();
  const machines = loadAssistMachines();
  const entry = machines.find((machine) => machine.code === normalized);
  if (!entry) return machines;
  const trimmed = name.trim();
  entry.name = trimmed ? trimmed : defaultAssistMachineName(normalized);
  saveAssistMachines(machines);
  return machines;
}

/** 删除条目；仅移除列表记录，不影响当前生效码（活动行由弹窗侧禁止删除）。 */
export function removeAssistMachine(code: string): AssistMachine[] {
  const normalized = normalizeAssistCode(code);
  if (!normalized) return loadAssistMachines();
  const kept = loadAssistMachines().filter((machine) => machine.code !== normalized);
  saveAssistMachines(kept);
  return kept;
}

/** 本机轮换后把旧码条目替换为新码（保留名称与顺序）；新码若已存在则并入旧条目。 */
export function replaceAssistMachineCode(previousCode: string, nextCode: string): AssistMachine[] {
  const previous = normalizeAssistCode(previousCode);
  const next = normalizeAssistCode(nextCode);
  if (!previous || !next) return loadAssistMachines();
  const machines = loadAssistMachines();
  const entry = machines.find((machine) => machine.code === previous);
  if (!entry) {
    upsertAssistMachine(next);
    return loadAssistMachines();
  }
  entry.code = next;
  // 新码若已存在同名条目则并入旧条目位置，避免重复行。
  const kept = machines.filter((machine) => machine === entry || machine.code !== next);
  saveAssistMachines(kept);
  return kept;
}
