// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSaveFile } from "../src/webSaveFile.js";

/**
 * jsdom 环境里全局 ArrayBuffer 是 jsdom 域的，而 TextEncoder 是 Node 的——
 * TextEncoder 产出的 buffer 过不了 `instanceof ArrayBuffer`（真实浏览器单域无此问题）。
 * 测试数据统一在测试域构造，保证与被测实现同一 realm。
 */
function arrayBufferFromText(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
}

interface RecordedClick {
  href: string | null;
  download: string | null;
  target: string | null;
}

function stubBrowserDownload() {
  const clicks: RecordedClick[] = [];
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];

  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "a") {
      return originalCreateElement(tag);
    }
    const link = {
      href: "",
      download: "",
      rel: "",
      target: "",
      remove: () => {},
      click: () => {
        clicks.push({
          href: link.href || null,
          download: link.download || null,
          target: link.target || null,
        });
      },
    };
    return link as unknown as HTMLAnchorElement;
  }) as typeof document.createElement);
  vi.spyOn(document.body, "appendChild").mockImplementation(() => null as never);
  vi.stubGlobal("URL", {
    createObjectURL: () => {
      const url = `blob:mock-${createdUrls.length}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => {
      revokedUrls.push(url);
    },
  });

  return { clicks, createdUrls, revokedUrls };
}

describe("createWebSaveFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects invalid payloads like the desktop handler", async () => {
    stubBrowserDownload();
    const saveFile = createWebSaveFile();
    await expect(saveFile({ suggestedName: "", data: new ArrayBuffer(4) })).resolves.toEqual({
      success: false,
      error: "invalid_file_payload",
    });
    await expect(saveFile({ suggestedName: "a.csv", data: new ArrayBuffer(0) })).resolves.toEqual({
      success: false,
      error: "invalid_file_payload",
    });
    await expect(saveFile({ suggestedName: "a.csv" } as never)).resolves.toEqual({
      success: false,
      error: "invalid_file_payload",
    });
  });

  it("downloads data bytes through an object URL anchor and revokes it", async () => {
    const { clicks, createdUrls, revokedUrls } = stubBrowserDownload();
    const saveFile = createWebSaveFile();

    const bytes = arrayBufferFromText("province,city\n湖北,武汉\n");
    const result = await saveFile({ data: bytes, suggestedName: "导出.csv" });

    expect(result).toEqual({ success: true });
    expect(createdUrls).toHaveLength(1);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.download).toBe("导出.csv");
    expect(clicks[0]?.href).toBe("blob:mock-0");
    expect(revokedUrls).toEqual(createdUrls);
  });

  it("sanitizes path separators and control characters in the suggested name", async () => {
    const { clicks } = stubBrowserDownload();
    const saveFile = createWebSaveFile();

    await saveFile({
      data: new ArrayBuffer(2),
      suggestedName: "../目录/报告\u0007v2.xlsx\n",
    });

    expect(clicks[0]?.download).toBe("报告_v2.xlsx");
  });

  it("delegates sourceUrl to browser navigation without an object URL", async () => {
    const { clicks, createdUrls } = stubBrowserDownload();
    const saveFile = createWebSaveFile();

    const result = await saveFile({
      sourceUrl: "https://example.com/report.pdf",
      suggestedName: "report.pdf",
    });

    expect(result).toEqual({ success: true });
    expect(createdUrls).toHaveLength(0);
    expect(clicks[0]?.href).toBe("https://example.com/report.pdf");
    expect(clicks[0]?.target).toBe("_blank");
  });
});
