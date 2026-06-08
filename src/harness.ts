import { spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(__dirname, "..", "harness.sh");

export class HarnessError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly stderr: string
  ) {
    super(`harness.sh ${cmd} failed:\n${stderr}`);
  }
}

export class StartupFailure extends Error {
  constructor(public readonly reason: string) {
    super(`Startup failed:\n${reason}`);
  }
}

export function harness(app: string, ...args: string[]): string {
  const result = spawnSync(HARNESS, [app, ...args], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new HarnessError(`${app} ${args.join(" ")}`, result.stderr ?? "");
  }
  return result.stdout ?? "";
}

export function harnessStart(app: string): void {
  const result = spawnSync(HARNESS, [app, "start"], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new StartupFailure(result.stderr ?? "");
  }
}

export function readAppConfig(app: string): { dataset: string } {
  const configPath = resolve(__dirname, "..", "apps", app, "config.sh");
  const content = readFileSync(configPath, "utf8");
  const match = content.match(/APP_DATASET="([^"]+)"/);
  return { dataset: match?.[1] ?? app };
}

export function readSkillVersion(
  app: string
): { branch: string; sha: string; commit: string } {
  try {
    const versionPath = resolve(__dirname, "..", "checkouts", app, ".skill-version");
    const content = readFileSync(versionPath, "utf8");
    const branch = content.match(/SKILL_BRANCH=(.+)/)?.[1]?.trim() ?? "unknown";
    const sha = content.match(/SKILL_SHA=(.+)/)?.[1]?.trim() ?? "unknown";
    const commit =
      content.match(/SKILL_COMMIT_MSG="(.+)"/)?.[1]?.trim() ?? "unknown";
    return { branch, sha, commit };
  } catch {
    return { branch: "unknown", sha: "unknown", commit: "unknown" };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
