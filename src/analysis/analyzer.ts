import { unimplemented } from "../shared/unimplemented.js";
import type { ReviewFocusAnalyzer } from "./types.js";

export function createUnimplementedAnalyzer(): ReviewFocusAnalyzer {
  return {
    assess: unimplemented("ReviewFocusAnalyzer.assess"),
  };
}
