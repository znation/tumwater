import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { piListedModelsPath } from "../paths.js";

/** What `pi --list-models` last said about image input, per `provider/model`. */
export interface PiListedModels {
  checkedAt: number;
  images: Record<string, boolean>;
}

/** Read the `images` column of the table `pi --list-models` prints. Null unless the first
 * non-blank line is the `provider model …` header and it has an `images` column. A row's
 * `yes`/`no` maps to a boolean; any other value is skipped. */
export function parsePiModelImages(stdout: string): Record<string, boolean> | null {
  const rows = stdout.split("\n").map((line) => line.trim().split(/\s+/)).filter((t) => t[0] !== "");
  const header = rows.shift();
  if (header?.[0] !== "provider" || header[1] !== "model") return null;
  const column = header.indexOf("images");
  if (column < 0) return null;
  const images: Record<string, boolean> = {};
  for (const row of rows) {
    const [provider, model] = row;
    if (model === undefined) continue;
    if (row[column] === "yes") images[`${provider}/${model}`] = true;
    else if (row[column] === "no") images[`${provider}/${model}`] = false;
  }
  return images;
}

/** The saved listing, or null when the file is missing, torn, or has no `images` object. */
export function readPiListedModels(root: string): PiListedModels | null {
  const saved = readJsonFile<Partial<PiListedModels>>(piListedModelsPath(root));
  const images = saved?.images;
  if (typeof images !== "object" || images === null || Array.isArray(images)) return null;
  return { checkedAt: typeof saved?.checkedAt === "number" ? saved.checkedAt : 0, images };
}

export function writePiListedModels(root: string, images: Record<string, boolean>, now: number = Date.now()): void {
  writeJsonAtomic(piListedModelsPath(root), { checkedAt: now, images });
}

/** Whether pi lists `provider/model` as reading images; null when unlisted or an argument is
 * missing. No TTL: every doctor run that lists the models rewrites the file. */
export function piListedImageInput(
  listed: PiListedModels | null | undefined,
  provider: string | undefined,
  model: string | undefined,
): boolean | null {
  if (!listed || provider === undefined || model === undefined) return null;
  return listed.images[`${provider}/${model}`] ?? null;
}
