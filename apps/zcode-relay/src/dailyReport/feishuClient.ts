// 飞书开放平台最小客户端（specs/web-daily-report.md）：对齐 skillpie 工程 lib/feishu/client.ts 的调用方式。
// oneshot 进程每次现取 tenant_access_token，无需进程内缓存。
const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

interface TokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

/** 用 app_id/app_secret 换租户凭据；失败抛错（调用方决定是否视为致命）。 */
export async function getTenantAccessToken(credentials: FeishuCredentials): Promise<string> {
  const response = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
  });
  const data = (await response.json()) as TokenResponse;
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`tenant_access_token 获取失败: code=${data.code} msg=${data.msg ?? ""}`);
  }
  return data.tenant_access_token;
}

interface MessageResponse {
  code: number;
  msg?: string;
}

/** 发送 interactive 卡片；返回飞书响应文案用于日志。 */
export async function sendInteractiveCard(
  token: string,
  receiveIdType: string,
  body: unknown,
): Promise<string> {
  const response = await fetch(
    `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const data = (await response.json()) as MessageResponse;
  if (data.code !== 0) {
    throw new Error(`卡片发送失败: code=${data.code} msg=${data.msg ?? ""}`);
  }
  return data.msg ?? "success";
}

interface ChatListResponse {
  code: number;
  msg?: string;
  data?: { items?: Array<{ chat_id: string; name?: string }> };
}

/** 列出机器人所在的群（`--list-chats` 调试用：帮部署者拿 chat_id 配置群发送）。 */
export async function listBotChats(
  token: string,
): Promise<Array<{ chatId: string; name: string }>> {
  const response = await fetch(`${FEISHU_API_BASE}/im/v1/chats?page_size=50`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = (await response.json()) as ChatListResponse;
  if (data.code !== 0) {
    throw new Error(`群列表获取失败: code=${data.code} msg=${data.msg ?? ""}`);
  }
  return (data.data?.items ?? []).map((item) => ({ chatId: item.chat_id, name: item.name ?? "" }));
}
