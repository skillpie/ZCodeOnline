import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_DOWNLOAD_PATHS,
  detectDesktopDownloadPlatform,
  resolveDesktopDownloadUrl,
} from "../src/desktopDownloadUrl.js";

// 「下载桌面版」直链解析与 UA 推荐逻辑：链接只由站点基址 + 固定路径拼出，
// 固定路径即人工上传安装包的约定文件名，改名会直接 404，测试锁住防止无意变更。

test("安装包路径按平台固定,不带版本号", () => {
  assert.equal(DESKTOP_DOWNLOAD_PATHS.mac, "/dl/desktop/ZCode-latest-mac-arm64.dmg");
  assert.equal(DESKTOP_DOWNLOAD_PATHS.windows, "/dl/desktop/ZCode-latest-win-x64.exe");
});

test("resolveDesktopDownloadUrl 拼接站点基址并容忍尾部斜杠", () => {
  assert.equal(
    resolveDesktopDownloadUrl("mac", "https://zcode.skillpie.cn"),
    "https://zcode.skillpie.cn/dl/desktop/ZCode-latest-mac-arm64.dmg",
  );
  assert.equal(
    resolveDesktopDownloadUrl("windows", "https://zcode.skillpie.cn/"),
    "https://zcode.skillpie.cn/dl/desktop/ZCode-latest-win-x64.exe",
  );
});

test("detectDesktopDownloadPlatform 按UA识别桌面系统", () => {
  const macUa =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  const windowsUa =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  const iphoneUa =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  assert.equal(detectDesktopDownloadPlatform(macUa), "mac");
  assert.equal(detectDesktopDownloadPlatform(windowsUa), "windows");
  assert.equal(detectDesktopDownloadPlatform(iphoneUa), null);
  assert.equal(detectDesktopDownloadPlatform(""), null);
});
