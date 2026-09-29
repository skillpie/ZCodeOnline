import assert from "node:assert/strict";
import test from "node:test";
import {
  getDefaultShortcutBindings,
  isValidShortcutBinding,
  SHORTCUT_COMMANDS,
  type ShortcutCommandId,
} from "@zcode/shared";
import { checkShortcutBindingConflict, isSamePhysicalBinding } from "../src/shortcuts/conflicts.js";

const APPLE_PLATFORM = { platform: "MacIntel" };
const WINDOWS_PLATFORM = { platform: "Win32" };

/** 同作用域命令的默认键位物理唯一（一键一命令在默认表层面成立，双平台各自成立）。 */
function assertDefaultBindingsUniquePerScope(platformInfo: { platform: string }): void {
  for (const scope of ["global", "composer"] as const) {
    const bindings = SHORTCUT_COMMANDS.filter(
      (entry) => (entry.scope ?? "global") === scope,
    ).flatMap((entry) =>
      getDefaultShortcutBindings(entry.id).map((binding) => ({
        id: entry.id as ShortcutCommandId,
        binding,
      })),
    );
    for (const [index, candidate] of bindings.entries()) {
      for (const other of bindings.slice(index + 1)) {
        assert.ok(
          !isSamePhysicalBinding(candidate.binding, other.binding, { platformInfo }),
          `${candidate.id} 与 ${other.id} 的默认键位物理冲突：${candidate.binding} / ${other.binding}`,
        );
      }
    }
  }
}

test("every default binding is in canonical form", () => {
  for (const entry of SHORTCUT_COMMANDS) {
    for (const binding of entry.defaultBindings) {
      assert.ok(isValidShortcutBinding(binding), `${entry.id} 的默认键位不是规范形式：${binding}`);
    }
  }
});

test("default bindings are physically unique per scope on both platforms", () => {
  assertDefaultBindingsUniquePerScope(APPLE_PLATFORM);
  assertDefaultBindingsUniquePerScope(WINDOWS_PLATFORM);
});

test("no default binding hits reserved or occupied conflicts", () => {
  for (const platformInfo of [APPLE_PLATFORM, WINDOWS_PLATFORM]) {
    for (const entry of SHORTCUT_COMMANDS) {
      for (const binding of entry.defaultBindings) {
        assert.equal(
          checkShortcutBindingConflict(entry.id, binding, undefined, { platformInfo }),
          null,
          `${entry.id} 的默认键位 ${binding} 触发冲突`,
        );
      }
    }
  }
});

test("git tool commands bind to the 2026-09-29 defaults", () => {
  // 头部「提交 / 拉取」按钮的快捷键；⇧⌘P 原为 openCommandCenter 第二默认键，
  // ⇧⌘U 原为 toggleInterfaceMode，均让位（用户决策）。
  assert.deepEqual(getDefaultShortcutBindings("gitCommit"), ["CmdOrCtrl+Shift+p"]);
  assert.deepEqual(getDefaultShortcutBindings("gitPull"), ["CmdOrCtrl+Shift+u"]);
  assert.deepEqual(getDefaultShortcutBindings("openCommandCenter"), ["CmdOrCtrl+k"]);
  assert.deepEqual(getDefaultShortcutBindings("toggleInterfaceMode"), ["CmdOrCtrl+u"]);
});
