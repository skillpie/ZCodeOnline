import { describe, expect, it } from "vitest";
import { rewriteBareFilePathsToMarkdownLinks } from "@/lib/assistantFilePathLinks.js";

describe("rewriteBareFilePathsToMarkdownLinks", () => {
  it("rewrites a POSIX absolute path with a Chinese filename into a file link", () => {
    const input =
      "导出完成。CSV 文件在：/Users/yuanfangx/Projects/fengqun-scm/武汉快递仓覆盖地区/fengqun_scm_csv_wms_warehouse_region_20261017-155559.csv（622 行数据）。";
    const output = rewriteBareFilePathsToMarkdownLinks(input);
    expect(output).toContain(
      "[fengqun_scm_csv_wms_warehouse_region_20261017-155559.csv](/Users/yuanfangx/Projects/fengqun-scm/武汉快递仓覆盖地区/fengqun_scm_csv_wms_warehouse_region_20261017-155559.csv)",
    );
    // 中文全角括号留在链接外
    expect(output.endsWith("（622 行数据）。")).toBe(true);
  });

  it("rewrites Windows drive, home-relative and dot-relative paths", () => {
    expect(rewriteBareFilePathsToMarkdownLinks("see C:\\Users\\me\\报表.xlsx")).toBe(
      "see [报表.xlsx](C:\\Users\\me\\报表.xlsx)",
    );
    expect(rewriteBareFilePathsToMarkdownLinks("check ~/docs/a.csv")).toBe(
      "check [a.csv](~/docs/a.csv)",
    );
    expect(rewriteBareFilePathsToMarkdownLinks("output at ./out/b.pdf and ../c.xlsx.")).toBe(
      "output at [b.pdf](./out/b.pdf) and [c.xlsx](../c.xlsx).",
    );
  });

  it("links several paths in one line and strips line-number suffixes", () => {
    const output = rewriteBareFilePathsToMarkdownLinks("/tmp/a.csv 和 /tmp/b.xlsx:12:34 是结果");
    expect(output).toBe("[a.csv](/tmp/a.csv) 和 [b.xlsx](/tmp/b.xlsx):12:34 是结果");
  });

  it("leaves plain prose, extension-less and filename-only mentions untouched", () => {
    expect(rewriteBareFilePathsToMarkdownLinks("没有任何路径的一句话。")).toBe(
      "没有任何路径的一句话。",
    );
    expect(rewriteBareFilePathsToMarkdownLinks("文件在 /tmp/exports 目录下")).toBe(
      "文件在 /tmp/exports 目录下",
    );
    expect(rewriteBareFilePathsToMarkdownLinks("见 report.csv 即可")).toBe("见 report.csv 即可");
  });

  it("does not rewrite inside fenced code blocks or inline code", () => {
    expect(rewriteBareFilePathsToMarkdownLinks("示例：\n```\n/tmp/in-code.csv\n```\n完。")).toBe(
      "示例：\n```\n/tmp/in-code.csv\n```\n完。",
    );
    expect(rewriteBareFilePathsToMarkdownLinks("运行 `cat /tmp/a.csv` 查看")).toBe(
      "运行 `cat /tmp/a.csv` 查看",
    );
  });

  it("does not touch existing markdown links, images, directives or URLs", () => {
    expect(rewriteBareFilePathsToMarkdownLinks("[报表](/tmp/report.csv) 已生成")).toBe(
      "[报表](/tmp/report.csv) 已生成",
    );
    expect(rewriteBareFilePathsToMarkdownLinks("![图](/tmp/img.png) 完毕")).toBe(
      "![图](/tmp/img.png) 完毕",
    );
    expect(
      rewriteBareFilePathsToMarkdownLinks('::zcode-file-citation{path="/tmp/report.csv"} 已导出'),
    ).toBe('::zcode-file-citation{path="/tmp/report.csv"} 已导出');
    expect(rewriteBareFilePathsToMarkdownLinks("详情见 https://example.com/data/a.csv 页面")).toBe(
      "详情见 https://example.com/data/a.csv 页面",
    );
    expect(rewriteBareFilePathsToMarkdownLinks("本地文件 file:///tmp/a.csv 可直接打开")).toBe(
      "本地文件 file:///tmp/a.csv 可直接打开",
    );
  });
});
