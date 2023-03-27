import jiti from "jiti";
import defu from "defu";
import { resolveSchema } from "../schema";
import type { Schema } from "../types";
import untypedPlugin from "./babel";

// TODO: https://github.com/unjs/jiti/issues/132
type JITIOptions = Parameters<typeof jiti>[1];

export interface LoaderOptions {
  jiti?: JITIOptions;
  defaults?: Record<string, any>;
}

export async function loadSchema(
  entryPath: string,
  options: LoaderOptions
): Promise<Schema> {
  const _jitiRequire = jiti(
    process.cwd(),
    defu(options.jiti, {
      esmResolve: true,
      interopDefault: true,
      transformOptions: {
        babel: {
          plugins: [untypedPlugin],
        },
      },
    })
  );

  const resolvedEntryPath = _jitiRequire.resolve(entryPath);
  const rawSchema = _jitiRequire(resolvedEntryPath);

  const schema = await resolveSchema(rawSchema, options.defaults);

  return schema;
}
