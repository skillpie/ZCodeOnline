// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceFileTooLargeError,
  isWorkspaceFileTooLargeError,
  readWorkspaceFileBytes,
  saveBytesToLocal,
  WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES,
} from "@/lib/workspaceFileDownload.js";

function makeRangeSource(content: Uint8Array) {
  return (offset: number, length: number) =>
    Promise.resolve(content.subarray(offset, offset + length));
}

describe("readWorkspaceFileBytes", () => {
  it("reads a file in chunks when stat reports the size", async () => {
    const content = new TextEncoder().encode("a".repeat(WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES + 7));
    const requestedRanges: Array<[number, number]> = [];

    const { bytes, sizeBytes } = await readWorkspaceFileBytes({
      path: "/tmp/export.xlsx",
      stat: () => Promise.resolve({ type: "file", size: content.byteLength }),
      readRange: (offset, length) => {
        requestedRanges.push([offset, length]);
        return Promise.resolve(content.subarray(offset, offset + length));
      },
    });

    expect(sizeBytes).toBe(content.byteLength);
    expect(Array.from(bytes.subarray(0, 4))).toEqual(Array.from(content.subarray(0, 4)));
    expect(bytes.byteLength).toBe(content.byteLength);
    expect(requestedRanges).toEqual([
      [0, WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES],
      [WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES, 7],
    ]);
  });

  it("falls back to accumulate-until-short-chunk when stat has no size", async () => {
    const content = new TextEncoder().encode("b".repeat(WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES + 3));

    const { bytes, sizeBytes } = await readWorkspaceFileBytes({
      path: "/tmp/export.csv",
      stat: () => Promise.resolve({ type: "file" }),
      readRange: makeRangeSource(content),
    });

    expect(sizeBytes).toBe(content.byteLength);
    expect(bytes.byteLength).toBe(content.byteLength);
  });

  it("rejects directories and over-limit files before reading", async () => {
    await expect(
      readWorkspaceFileBytes({
        path: "/tmp/dir",
        stat: () => Promise.resolve({ type: "directory", size: 10 }),
        readRange: () => Promise.resolve(new Uint8Array(0)),
      }),
    ).rejects.toMatchObject({ code: "workspace_file_not_a_file" });

    await expect(
      readWorkspaceFileBytes({
        path: "/tmp/huge.bin",
        stat: () => Promise.resolve({ type: "file", size: 51 * 1024 * 1024 }),
        readRange: () => Promise.resolve(new Uint8Array(0)),
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileTooLargeError);
  });

  it("enforces maxBytes while accumulating an unknown-size file", async () => {
    const chunk = new Uint8Array(WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES).fill(1);
    await expect(
      readWorkspaceFileBytes({
        path: "/tmp/unknown-size.bin",
        stat: () => Promise.resolve({ type: "file" }),
        readRange: () => Promise.resolve(chunk),
        maxBytes: WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileTooLargeError);
  });

  it("rejects empty chunks and oversized ranges as incomplete reads", async () => {
    await expect(
      readWorkspaceFileBytes({
        path: "/tmp/truncated.bin",
        stat: () => Promise.resolve({ type: "file", size: 10 }),
        readRange: () => Promise.resolve(new Uint8Array(0)),
      }),
    ).rejects.toMatchObject({ code: "workspace_file_read_incomplete" });

    await expect(
      readWorkspaceFileBytes({
        path: "/tmp/overrange.bin",
        stat: () => Promise.resolve({ type: "file", size: 10 }),
        readRange: () => Promise.resolve(new Uint8Array(11)),
      }),
    ).rejects.toMatchObject({ code: "workspace_file_range_exceeded" });
  });
});

describe("saveBytesToLocal", () => {
  const bytes = new Uint8Array(new ArrayBuffer(3));

  it("prefers platform.saveFile and maps cancel/success/error", async () => {
    const result = await saveBytesToLocal({
      platform: {
        saveFile: () => Promise.resolve({ success: true, path: "/Users/u/Downloads/a.xlsx" }),
      },
      bytes,
      fileName: "a.xlsx",
    });
    expect(result).toEqual({ status: "saved", via: "platform", path: "/Users/u/Downloads/a.xlsx" });

    const canceled = await saveBytesToLocal({
      platform: { saveFile: () => Promise.resolve({ success: false, canceled: true }) },
      bytes,
      fileName: "a.xlsx",
    });
    expect(canceled).toEqual({ status: "canceled" });

    const failed = await saveBytesToLocal({
      platform: { saveFile: () => Promise.resolve({ success: false, error: "file_too_large" }) },
      bytes,
      fileName: "a.xlsx",
    });
    expect(failed).toEqual({ status: "error", error: "file_too_large" });
  });

  it("falls back to the browser anchor download when the platform lacks saveFile", async () => {
    const createdUrls: string[] = [];
    const clicks: Array<string | null> = [];
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag !== "a") return originalCreateElement(tag);
      const link = {
        href: "",
        download: "",
        remove: () => {},
        click: () => clicks.push(link.download || null),
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
      revokeObjectURL: () => {},
    });

    const outcome = await saveBytesToLocal({
      platform: null,
      bytes,
      fileName: "报表.xlsx",
    });

    expect(outcome).toEqual({ status: "started", via: "browser" });
    expect(clicks).toEqual(["报表.xlsx"]);
    expect(createdUrls).toHaveLength(1);

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects empty bytes and blank names like the platform handlers", async () => {
    const empty = new Uint8Array(new ArrayBuffer(0));
    await expect(
      saveBytesToLocal({
        platform: { saveFile: () => Promise.resolve({ success: true }) },
        bytes: empty,
        fileName: "a.bin",
      }),
    ).resolves.toEqual({ status: "error", error: "invalid_file_payload" });
    await expect(saveBytesToLocal({ platform: null, bytes, fileName: "   " })).resolves.toEqual({
      status: "error",
      error: "invalid_file_payload",
    });
  });
});

describe("isWorkspaceFileTooLargeError", () => {
  it("matches the class and code-only lookalikes", () => {
    expect(isWorkspaceFileTooLargeError(new WorkspaceFileTooLargeError(1, 1))).toBe(true);
    expect(isWorkspaceFileTooLargeError({ code: "workspace_file_too_large" })).toBe(true);
    expect(isWorkspaceFileTooLargeError(new Error("nope"))).toBe(false);
  });
});
