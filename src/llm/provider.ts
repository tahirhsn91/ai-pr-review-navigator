import { unimplemented } from "../shared/unimplemented.js";
import type { LlmProvider } from "./types.js";

export function unimplementedExplainAttention(): LlmProvider["explainAttention"] {
  return unimplemented("LlmProvider.explainAttention");
}
