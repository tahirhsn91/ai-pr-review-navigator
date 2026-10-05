const boundaries = [
  {
    name: "config",
    responsibility:
      "Owns loading and Zod validation for environment variables and the review-focus policy.",
  },
  {
    name: "github",
    responsibility:
      "Owns pull request event metadata and GitHub REST reads of patches and file text.",
  },
  {
    name: "diff",
    responsibility:
      "Owns the file, hunk, changed-line, and base/head source model of a pull request diff.",
  },
  {
    name: "parser",
    responsibility: "Owns mapping changed lines onto TypeScript and JavaScript logical blocks.",
  },
  {
    name: "analysis",
    responsibility: "Owns behavioral assessments of changed logical blocks.",
  },
  {
    name: "prioritization",
    responsibility: "Owns ranking blocks and applying the policy selection limits.",
  },
  {
    name: "llm",
    responsibility:
      "Owns Claude and GPT completions used for behavioral assessment. Explanations of selected blocks stay unimplemented.",
  },
  {
    name: "publisher",
    responsibility: "Owns posting the focus report to the pull request.",
  },
  {
    name: "shared",
    responsibility: "Owns errors, source locations, and shared vocabulary.",
  },
] as const;

export const MODULE_BOUNDARIES = boundaries;

export type ModuleName = (typeof boundaries)[number]["name"];

export const MODULE_IMPORTS: Record<ModuleName, readonly ModuleName[]> = {
  shared: [],
  config: ["shared"],
  github: ["shared"],
  diff: ["shared", "github"],
  parser: ["shared", "diff"],
  analysis: ["shared", "parser"],
  prioritization: ["shared", "parser", "analysis", "config"],
  llm: ["shared"],
  publisher: ["shared", "github"],
};

export const PIPELINE_STAGES = [
  "github",
  "diff",
  "parser",
  "analysis",
  "prioritization",
  "llm",
  "publisher",
] as const satisfies readonly ModuleName[];
