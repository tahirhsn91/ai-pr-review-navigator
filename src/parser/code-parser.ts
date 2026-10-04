import { unimplemented } from "../shared/unimplemented.js";
import type { CodeParser } from "./types.js";

export function createUnimplementedCodeParser(): CodeParser {
  return {
    findChangedBlocks: unimplemented("CodeParser.findChangedBlocks"),
  };
}
