import type { PullRequestFile } from "../github/types.js";
import { parseUnifiedDiff } from "./parse-patch.js";
import type { DiffParser, FileDiff } from "./types.js";

export function parsePullRequestFile(file: PullRequestFile): FileDiff {
  const identity = {
    path: file.filename,
    status: file.status,
    ...(file.previousFilename === undefined ? {} : { previousPath: file.previousFilename }),
  };
  if (file.patch === undefined) {
    return {
      ...identity,
      hunks: [],
      addedRanges: [],
      removedRanges: [],
      patchStatus: "missing",
      lineMappingComplete: false,
    };
  }

  const parsed = parseUnifiedDiff(file.patch);
  if (parsed.patchStatus === "binary") {
    return {
      ...identity,
      hunks: [],
      addedRanges: [],
      removedRanges: [],
      patchStatus: "binary",
      lineMappingComplete: false,
    };
  }
  if (parsed.patchStatus === "invalid") {
    return {
      ...identity,
      hunks: [],
      addedRanges: [],
      removedRanges: [],
      patchStatus: "invalid",
      lineMappingComplete: false,
    };
  }

  const countsAgree =
    (file.additions === undefined || file.additions === parsed.addedCount) &&
    (file.deletions === undefined || file.deletions === parsed.removedCount);

  return {
    ...identity,
    hunks: parsed.hunks,
    addedRanges: parsed.addedRanges,
    removedRanges: parsed.removedRanges,
    patchStatus: countsAgree ? "parsed" : "invalid",
    lineMappingComplete: countsAgree,
  };
}

export function createDiffParser(): DiffParser {
  return {
    parse(files) {
      return files.map(parsePullRequestFile);
    },
  };
}
