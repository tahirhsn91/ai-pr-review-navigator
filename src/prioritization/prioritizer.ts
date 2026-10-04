import { unimplementedSync } from "../shared/unimplemented.js";
import type { Prioritizer } from "./types.js";

export function createUnimplementedPrioritizer(): Prioritizer {
  return {
    rank: unimplementedSync("Prioritizer.rank"),
  };
}
