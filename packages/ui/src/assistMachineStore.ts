// 浏览器侧远程码存储（specs/web-tunnel.md §5.9）：两条 localStorage 数据的唯一读写路径。
// - `zcode-assist-code`：当前生效的远程码（"码即凭证"的连接目标；打开带码链接后到，
//   弹窗「切换」也会改写它）。
// - `zcode-assist-machines`：用过的远程链接列表（码 + 展示名 + 隐藏本机标记，默认名 = 码），
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
  /**
   * 隐藏标记：该码曾由回环发现端点确认为「浏览器所在机器」的本机码。本机换码若发生在
   * 其他浏览器（他处点刷新、宿主身份重建），本浏览器无从得知新旧码的关联，弹窗会把
   * 新码当新机器另登记一条「我的ZCode」；据此标记把新发现的本机码并入旧条目（原位
   * 换码、保留名称），列表至多一个本机条目。
   */
  local?: boolean;
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
      const machine: AssistMachine = {
        code,
        name:
          typeof name === "string" && name.trim() ? name.trim() : defaultAssistMachineName(code),
      };
      // 非严格 true 视为无标记（历史数据 / 脏数据自愈）。
      if ((item as { local?: unknown }).local === true) machine.local = true;
      machines.push(machine);
    }
    return machines;
  } catch {
    return [];
  }
}

function saveAssistMachines(machines: AssistMachine[]): void {
  localStorage.setItem(MACHINES_STORAGE_KEY, JSON.stringify(machines));
}

/** 仅当条目名仍是「<码>的ZCode」缺省名（未被用户改过）时升级为传入的默认名。 */
function maybeUpgradeDefaultName(entry: AssistMachine, defaultName?: string): boolean {
  const nextDefault = defaultName?.trim();
  if (!nextDefault || entry.name !== defaultAssistMachineName(entry.code)) return false;
  entry.name = nextDefault;
  return true;
}

/** 本机标记唯一化：entry 之外的 local 全部清除（多条 local 的脏数据自愈）。 */
function markAsLocalMachine(machines: AssistMachine[], entry: AssistMachine): void {
  for (const machine of machines) {
    if (machine === entry) machine.local = true;
    else delete machine.local;
  }
}

/**
 * 打开带码链接 / 发现本机码时登记：新码以默认名（缺省「<码>的ZCode」）入列，已有码
 * 保留名称；仅当旧名称仍是码默认名（未被用户改过）时才升级为传入的 defaultName
 * （本机条目用它把默认名定为「我的ZCode」）。注意：打开链接 / 远程切换不等于本机，
 * 不打 local 标记——确认本机必须走回环发现的 upsertLocalAssistMachine。
 */
export function upsertAssistMachine(code: string, defaultName?: string): AssistMachine | null {
  const normalized = normalizeAssistCode(code);
  if (!normalized) return null;
  const machines = loadAssistMachines();
  const existing = machines.find((machine) => machine.code === normalized);
  if (existing) {
    if (maybeUpgradeDefaultName(existing, defaultName)) saveAssistMachines(machines);
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

/**
 * 登记回环发现确认的本机码（权威路径）。调用方必须区分：平台 getRemoteAssistCode
 * 在宿主不可达时会回退返回本地存储的活动码（expiresAt = null），那可能是正在远控的
 * 其他机器，误标会让后续合并吃掉远端条目——只有权威发现（expiresAt 非 null）走这里。
 * local 条目至多一条：发现新本机码时优先并入旧 local 条目，原位换码、保留名称与
 * 登记顺序，本机在别的浏览器换码后本浏览器不再多出一条重复的「我的ZCode」。
 */
export function upsertLocalAssistMachine(code: string, defaultName?: string): AssistMachine | null {
  const normalized = normalizeAssistCode(code);
  if (!normalized) return null;
  const machines = loadAssistMachines();
  const existing = machines.find((machine) => machine.code === normalized);
  if (existing) {
    markAsLocalMachine(machines, existing);
    maybeUpgradeDefaultName(existing, defaultName);
    saveAssistMachines(machines);
    return existing;
  }
  const previousLocal = machines.find((machine) => machine.local === true);
  if (previousLocal) {
    // 本机换码：并入旧条目。缺省名跟随新码；用户改过名则保留。
    if (previousLocal.name === defaultAssistMachineName(previousLocal.code)) {
      previousLocal.name = defaultName?.trim() || defaultAssistMachineName(normalized);
    }
    previousLocal.code = normalized;
    markAsLocalMachine(machines, previousLocal);
    saveAssistMachines(machines);
    return previousLocal;
  }
  const machine: AssistMachine = {
    code: normalized,
    name: defaultName?.trim() || defaultAssistMachineName(normalized),
    local: true,
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
    // 旧码条目缺失（如被手动删除）：轮换同样发生在宿主上，按本机登记兜底。
    upsertLocalAssistMachine(next);
    return loadAssistMachines();
  }
  entry.code = next;
  // 新码若已存在同名条目则并入旧条目位置，避免重复行。
  const kept = machines.filter((machine) => machine === entry || machine.code !== next);
  // 轮换只可能由宿主发起，替换后的条目仍是本机码，保持 local 标记。
  markAsLocalMachine(kept, entry);
  saveAssistMachines(kept);
  return kept;
}
