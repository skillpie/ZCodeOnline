import { ipcRenderer } from "electron";

// 技能市场 webview 专用 preload（注入判断见 desktopWindowChrome.ts 的
// isSkillMarketWebviewSrc）：为 ZCode → SkillPie 免登握手桥接宿主通信。
//
// Electron <webview> 的 guest 与宿主 renderer 是两个独立的 frame 树，
// window.parent 指向 guest 自身，浏览器 postMessage 无法跨到宿主；
// 这里用 ipc sendToHost/on 转发，页面侧协议与 iframe 场景完全一致：
// 1) guest 加载后向宿主发 skillpie:sso-request（宿主凭据读取是异步的，
//    由宿主收到请求后再回传，避免竞态）；
// 2) 收到宿主的 zcode:sso-response 后用 window.postMessage 投递到页面主世界，
//    SkillPie 的免登桥组件按 iframe 同一协议消费（见 skillpie 仓库
//    components/sso/zcode-sso-bridge.tsx 与 ZCode specs/skill-market.md）。

interface ZcodeSsoResponsePayload {
  type: "zcode:sso-response";
  jwt: string | null;
  profile?: { displayName?: string };
}

try {
  ipcRenderer.sendToHost("skillpie:sso-request");
} catch {
  // 宿主尚未 attach 时 sendToHost 会抛；页面后续导航会再次触发本 preload。
}

ipcRenderer.on("zcode:sso-response", (_event, payload: unknown) => {
  const data = payload as Partial<ZcodeSsoResponsePayload> | null;
  if (!data || data.type !== "zcode:sso-response") {
    return;
  }
  window.postMessage(
    { type: "zcode:sso-response", jwt: data.jwt ?? null, profile: data.profile ?? {} },
    window.location.origin,
  );
});
