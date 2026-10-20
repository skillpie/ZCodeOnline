import * as childProcess from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServiceDescriptor,
  isServiceManagerAvailable,
  launchdUserAgentDescriptorPath,
  registerService,
  unregisterService,
} from "../src/platform/serviceManager.js";

async function createTempHome(): Promise<string> {
  return await mkdtemp(join(homedir(), "zcode-service-test-"));
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe("service manager adapters", () => {
  afterEach(() => {
    vi.mocked(childProcess.spawn).mockReset();
  });

  it("finishes a timed-out probe while a descendant still holds its pipes", async () => {
    const { spawn } = await vi.importActual<typeof childProcess>("node:child_process");
    let descendantPid = 0;
    let settled = false;
    const exited = new Promise<void>((resolve, reject) => {
      vi.mocked(childProcess.spawn).mockImplementationOnce((_command, _args, options) => {
        // 模拟 D-Bus 辅助进程继承管道：探测父进程被超时杀死后，后代仍存活。
        const child = spawn(
          process.execPath,
          [
            "--eval",
            `const { spawn } = require("node:child_process");
             spawn(process.execPath, ["--eval", 'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);'], { stdio: ["ignore", "inherit", "inherit"] });
             setInterval(() => {}, 1000);`,
          ],
          options,
        );
        child.stdout?.on("data", (chunk) => {
          descendantPid = Number(String(chunk).trim());
        });
        child.once("error", reject);
        child.once("exit", () => resolve());
        return child;
      });
    });
    const probe = isServiceManagerAvailable("linux").then((available) => {
      settled = true;
      return available;
    });
    try {
      await exited;
      expect(descendantPid).toBeGreaterThan(0);
      expect(process.kill(descendantPid, 0)).toBe(true);
      // 只等待执行器完成收口；后代退出由 finally 控制，不以延长 timeout 掩盖阻塞。
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
      expect(await probe).toBe(false);
    } finally {
      if (descendantPid > 0) process.kill(descendantPid, "SIGKILL");
      await probe;
    }
  });

  it("keeps reading a successful probe until its inherited stdout closes", async () => {
    const child = new childProcess.ChildProcess();
    const output = new PassThrough();
    child.stdout = output;
    let settled = false;
    const spawned = new Promise<void>((resolve) => {
      vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
        resolve();
        return child;
      });
    });
    const probe = isServiceManagerAvailable("linux").then((available) => {
      settled = true;
      return available;
    });
    try {
      await spawned;
      // 固定 exit 先于剩余输出的事件顺序，不依赖真实后代进程的启动速度。
      child.emit("exit", 0, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      output.end("Version=252\n");
      child.emit("close", 0, null);
      expect(await probe).toBe(true);
    } finally {
      output.destroy();
      child.emit("close", 1, null);
      await probe;
    }
  });

  it("probes the Linux user service manager without registering a unit", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      timeoutMs: number | undefined;
    }> = [];
    await expect(
      isServiceManagerAvailable("linux", {
        run: async () => undefined,
        runResult: async (command, args, options) => {
          calls.push({ command, args, timeoutMs: options?.timeoutMs });
          return { exitCode: 0, stdout: "Version=249.11-0ubuntu3.22\n", stderr: "" };
        },
      }),
    ).resolves.toBe(true);
    expect(calls).toEqual([
      {
        command: "systemctl",
        args: ["--user", "show", "--property=Version"],
        timeoutMs: 2_000,
      },
    ]);
  });

  it("treats an inaccessible user service manager as a fallback capability", async () => {
    await expect(
      isServiceManagerAvailable("linux", {
        run: async () => undefined,
        runResult: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "Failed to connect to bus",
        }),
      }),
    ).resolves.toBe(false);
  });

  it("does not register against a skipped Linux probe that exits successfully", async () => {
    await expect(
      isServiceManagerAvailable("linux", {
        run: async () => undefined,
        runResult: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "Running in chroot, ignoring command 'show'\n",
        }),
      }),
    ).resolves.toBe(false);
  });

  it.each(["", "Version=\n", "Welcome to the server\n"])(
    "requires a manager response even when stderr is empty (stdout: %j)",
    async (stdout) => {
      await expect(
        isServiceManagerAvailable("linux", {
          run: async () => undefined,
          runResult: async () => ({ exitCode: 0, stdout, stderr: "" }),
        }),
      ).resolves.toBe(false);
    },
  );

  it("keeps a responding Linux manager available despite an unrelated warning", async () => {
    await expect(
      isServiceManagerAvailable("linux", {
        run: async () => undefined,
        runResult: async () => ({
          exitCode: 0,
          stdout: "Version=252\n",
          stderr: "A diagnostic warning\n",
        }),
      }),
    ).resolves.toBe(true);
  });

  it("maps all supported platforms to their native registration commands", async () => {
    const home = await createTempHome();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const executor = {
      run: async (command: string, args: readonly string[]) => {
        calls.push({ command, args });
      },
    };
    try {
      for (const platform of ["darwin", "linux", "win32"] as const) {
        const descriptor = createServiceDescriptor({
          platform,
          command: "/opt/zcode/bin/zcode",
          args: ["serve", "--daemon"],
        });
        await registerService(descriptor, `/tmp/${descriptor.kind}.service`, executor, {
          homeDir: home,
        });
        await unregisterService(descriptor, `/tmp/${descriptor.kind}.service`, executor, {
          homeDir: home,
        });
      }
      expect(calls.map((call) => call.command)).toEqual([
        // darwin register：卸载 serviceDir 旧注册 + 卸载 LaunchAgents 同名注册 + 从 LaunchAgents 加载并启动
        "launchctl",
        "launchctl",
        "launchctl",
        "launchctl",
        // darwin unregister：卸载 LaunchAgents + 卸载 serviceDir 残留
        "launchctl",
        "launchctl",
        "systemctl",
        "systemctl",
        "systemctl",
        "schtasks",
        "schtasks",
        "schtasks",
      ]);
      expect(calls.at(-2)?.args).toContain("/Run");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("installs the launchd plist into LaunchAgents so login auto-starts the daemon", async () => {
    const home = await createTempHome();
    const descriptor = createServiceDescriptor({
      platform: "darwin",
      command: "/opt/zcode/bin/zcode",
    });
    const userAgentPath = launchdUserAgentDescriptorPath(descriptor, home);
    const calls: string[][] = [];
    try {
      await registerService(
        descriptor,
        "/tmp/record.plist",
        {
          run: async (_command, args) => {
            calls.push([...args]);
          },
        },
        { homeDir: home },
      );
      const written = await readFile(userAgentPath, "utf8");
      expect(written).toBe(descriptor.content);
      expect(calls).toEqual([
        ["unload", "-w", "/tmp/record.plist"],
        ["unload", "-w", userAgentPath],
        ["load", "-w", userAgentPath],
        ["start", descriptor.name],
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("removes the LaunchAgents plist on unregister even when no service was loaded", async () => {
    const home = await createTempHome();
    const descriptor = createServiceDescriptor({
      platform: "darwin",
      command: "/opt/zcode/bin/zcode",
    });
    const userAgentPath = launchdUserAgentDescriptorPath(descriptor, home);
    await mkdir(join(userAgentPath, ".."), { recursive: true });
    await writeFile(userAgentPath, descriptor.content, "utf8");
    try {
      await expect(
        unregisterService(
          descriptor,
          "/tmp/zcode.plist",
          {
            run: async () => {
              throw new Error("launchctl unload failed (3): Could not find specified service");
            },
          },
          { homeDir: home },
        ),
      ).resolves.toBeUndefined();
      await expect(readFile(userAgentPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not restart a launchd service after a normal stop", () => {
    const descriptor = createServiceDescriptor({
      platform: "darwin",
      command: "/opt/zcode/bin/zcode",
    });
    expect(descriptor.content).toContain(
      "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    );
  });

  it("tolerates launchd unregister when a deferred registration was never loaded", async () => {
    const home = await createTempHome();
    const descriptor = createServiceDescriptor({
      platform: "darwin",
      command: "/opt/zcode/bin/zcode",
    });
    try {
      await expect(
        unregisterService(
          descriptor,
          "/tmp/zcode.plist",
          {
            run: async () => {
              throw new Error("launchctl unload failed (3): Could not find specified service");
            },
          },
          { homeDir: home },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("tolerates a missing Windows task when schtasks reports a missing file", async () => {
    const descriptor = createServiceDescriptor({
      platform: "win32",
      command: "C:/zcode/bin/zcode.cmd",
    });
    await expect(
      unregisterService(descriptor, "C:/zcode/service/task.json", {
        run: async () => {
          throw new Error(
            "schtasks /Delete failed (1): ERROR: The system cannot find the file specified.",
          );
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("does not swallow Windows task permission failures", async () => {
    const descriptor = createServiceDescriptor({
      platform: "win32",
      command: "C:/zcode/bin/zcode.cmd",
    });
    await expect(
      unregisterService(descriptor, "C:/zcode/service/task.json", {
        run: async () => {
          throw new Error("schtasks /Delete failed (5): Access is denied.");
        },
      }),
    ).rejects.toThrow(/Access is denied/);
  });

  it("uses the structured schtasks HRESULT probe before deleting a Windows task", async () => {
    const descriptor = createServiceDescriptor({
      platform: "win32",
      command: "C:/zcode/bin/zcode.cmd",
    });
    const calls: string[][] = [];
    await expect(
      unregisterService(descriptor, "C:/zcode/service/task.json", {
        run: async (_command, args) => {
          calls.push([...args]);
        },
        runResult: async (_command, args) => {
          calls.push([...args]);
          return { exitCode: 0x80070002, stdout: "", stderr: "" };
        },
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([["/Query", "/TN", descriptor.name, "/HResult"]]);
  });

  it("does not treat a structured Windows task query permission error as absence", async () => {
    const descriptor = createServiceDescriptor({
      platform: "win32",
      command: "C:/zcode/bin/zcode.cmd",
    });
    await expect(
      unregisterService(descriptor, "C:/zcode/service/task.json", {
        run: async () => undefined,
        runResult: async () => ({
          exitCode: 0x80070005,
          stdout: "",
          stderr: "Access is denied.",
        }),
      }),
    ).rejects.toThrow(/failed \(2147942405\)/);
  });

  it("reloads an existing launchd label before starting the new descriptor", async () => {
    const home = await createTempHome();
    const descriptor = createServiceDescriptor({
      platform: "darwin",
      command: "/opt/zcode/bin/zcode",
      args: ["serve", "--new"],
    });
    const userAgentPath = launchdUserAgentDescriptorPath(descriptor, home);
    const calls: string[][] = [];
    try {
      await registerService(
        descriptor,
        "/tmp/new.plist",
        {
          run: async (_command, args) => {
            calls.push([...args]);
            if (args[0] === "unload") throw new Error("Could not find specified service");
          },
        },
        { homeDir: home },
      );
      expect(calls).toEqual([
        ["unload", "-w", "/tmp/new.plist"],
        ["unload", "-w", userAgentPath],
        ["load", "-w", userAgentPath],
        ["start", descriptor.name],
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("propagates launchd load failures with both descriptor paths", async () => {
    const home = await createTempHome();
    const descriptor = createServiceDescriptor({
      platform: "darwin",
      command: "/opt/zcode/bin/zcode",
    });
    const userAgentPath = launchdUserAgentDescriptorPath(descriptor, home);
    try {
      await expect(
        registerService(
          descriptor,
          "/tmp/broken.plist",
          {
            run: async (_command, args) => {
              if (args[0] === "load") throw new Error("permission denied");
            },
          },
          { homeDir: home },
        ),
      ).rejects.toThrow(/broken\.plist/);
      await expect(
        registerService(
          descriptor,
          "/tmp/broken.plist",
          {
            run: async (_command, args) => {
              if (args[0] === "load") throw new Error("permission denied");
            },
          },
          { homeDir: home },
        ),
      ).rejects.toThrow(userAgentPath);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
