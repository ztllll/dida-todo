import { chmod, link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Copies a legacy local file only when the OMP target does not exist. `link` makes
 * target creation atomic: a concurrent/newer target wins without being replaced.
 */
export async function migrateLegacyLocalFile(legacyPath: string, targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let content: Buffer;
  try {
    content = await readFile(legacyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  const directory = dirname(targetPath);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(targetPath)}.${process.pid}.${Date.now()}.migration`);
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await chmod(temporary, 0o600);
    try {
      await link(temporary, targetPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
