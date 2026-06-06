import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(stripUtf8Bom(raw)) as T;
}

export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  const body = `${JSON.stringify(data, null, 2)}\n`;

  await mkdir(directory, { recursive: true });

  const handle = await open(tempPath, "w", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  await handle.close();

  try {
    await rename(tempPath, filePath);
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (process.platform === "win32" && (known.code === "EPERM" || known.code === "EEXIST")) {
      await rm(filePath, { force: true });
      await rename(tempPath, filePath);
      return;
    }
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
