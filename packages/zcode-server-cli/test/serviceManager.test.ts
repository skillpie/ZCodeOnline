import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createServiceDescriptor,
  launchdUserAgentDescriptorPath,
  registerService,
  unregisterService,
} from "../src/platform/serviceManager.js";

async function createTempHome(): Promise<string> {
  return await mkdtemp(join(homedir(), "zcode-service-test-"));
}

describe("service manager adapters", () => {
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
          return { exitCode: 0x80070002, stderr: "" };
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
        runResult: async () => ({ exitCode: 0x80070005, stderr: "Access is denied." }),
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
