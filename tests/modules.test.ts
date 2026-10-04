import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MODULE_BOUNDARIES, MODULE_IMPORTS, PIPELINE_STAGES } from "../src/shared/modules.js";
import { ATTENTION_REASON_LABELS, ATTENTION_REASONS } from "../src/shared/vocabulary.js";

const srcRoot = resolve("src");
const allowedPackages = new Set(["typescript", "zod", "yaml"]);

function walkTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walkTypeScriptFiles(path));
      continue;
    }
    if (entry.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function owningModule(filePath: string): string {
  const top = relative(srcRoot, filePath).split(/[\\/]/)[0] ?? "";
  return top.replace(/\.ts$/u, "");
}

function importedSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+["']([^"']+)["']/gu)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}

describe("module boundaries", () => {
  it("matches the src directories and gives each module one responsibility", () => {
    const directories = readdirSync(srcRoot)
      .filter((name) => statSync(join(srcRoot, name)).isDirectory())
      .sort();
    const names = MODULE_BOUNDARIES.map((boundary) => boundary.name);
    expect(directories).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);

    const responsibilities = MODULE_BOUNDARIES.map((boundary) => boundary.responsibility);
    expect(new Set(responsibilities).size).toBe(responsibilities.length);
    for (const responsibility of responsibilities) {
      expect(responsibility.length).toBeGreaterThan(20);
    }
  });

  it("keeps pipeline stages inside the module list", () => {
    const names = MODULE_BOUNDARIES.map((boundary) => boundary.name);
    for (const stage of PIPELINE_STAGES) {
      expect(names).toContain(stage);
    }
  });

  it("imports only allowed project modules and packages", () => {
    const violations: string[] = [];
    for (const filePath of walkTypeScriptFiles(srcRoot)) {
      const owner = owningModule(filePath);
      const allowed = allowedTargets(owner);
      for (const specifier of importedSpecifiers(readFileSync(filePath, "utf8"))) {
        if (!specifier.startsWith(".")) {
          const packageName = specifier.startsWith("node:") ? "node:" : specifier;
          if (packageName !== "node:" && !allowedPackages.has(specifier)) {
            violations.push(`${relative(srcRoot, filePath)} imports ${specifier}`);
          }
          continue;
        }
        if (specifier.startsWith("./") && !specifier.slice(2).includes("/")) {
          continue;
        }
        const target = resolve(dirname(filePath), specifier);
        const top = relative(srcRoot, target).split(/[\\/]/)[0]?.replace(/\.js$/u, "");
        if (top === undefined || top.startsWith("..") || !allowed.some((name) => name === top)) {
          violations.push(`${relative(srcRoot, filePath)} imports ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

function allowedTargets(owner: string): readonly string[] {
  const moduleNames = MODULE_BOUNDARIES.map((boundary) => boundary.name);
  if (owner === "index") {
    return ["pipeline", ...moduleNames];
  }
  if (owner === "pipeline") {
    return [...moduleNames];
  }
  if (!isModuleName(owner)) {
    return [];
  }
  return MODULE_IMPORTS[owner];
}

function isModuleName(owner: string): owner is keyof typeof MODULE_IMPORTS {
  return Object.prototype.hasOwnProperty.call(MODULE_IMPORTS, owner);
}

describe("attention vocabulary", () => {
  it("gives every reason one glossary label", () => {
    expect(Object.keys(ATTENTION_REASON_LABELS).sort()).toEqual([...ATTENTION_REASONS].sort());
    for (const label of Object.values(ATTENTION_REASON_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
      expect(label.toLowerCase()).not.toMatch(/bug|vulnerab|defect/);
    }
  });
});
