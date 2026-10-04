import { unimplementedSync } from "../shared/unimplemented.js";
import type { DiffParser } from "./types.js";

export function createUnimplementedDiffParser(): DiffParser {
  return {
    parse: unimplementedSync("DiffParser.parse"),
  };
}
