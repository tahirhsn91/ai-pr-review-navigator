export function splitSource(text: string | null): string[] {
  if (text === null) {
    return [];
  }
  return text.split("\n");
}

export function unifiedDiff(base: string | null, head: string | null): string {
  const oldLines = splitSource(base);
  const newLines = splitSource(head);
  const edits = diffLines(oldLines, newLines);
  if (!edits.some((edit) => edit.kind !== "equal")) {
    return "";
  }
  const oldStart = oldLines.length === 0 ? 0 : 1;
  const newStart = newLines.length === 0 ? 0 : 1;
  const header = `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`;
  const body = edits.map((edit) => {
    if (edit.kind === "delete") {
      return `-${edit.text}`;
    }
    if (edit.kind === "insert") {
      return `+${edit.text}`;
    }
    return ` ${edit.text}`;
  });
  return [header, ...body].join("\n");
}

export function contextDiff(text: string): string {
  const lines = splitSource(text);
  const header = `@@ -1,${lines.length} +1,${lines.length} @@`;
  return [header, ...lines.map((line) => ` ${line}`)].join("\n");
}

interface LineEdit {
  readonly kind: "equal" | "delete" | "insert";
  readonly text: string;
}

function diffLines(oldLines: readonly string[], newLines: readonly string[]): LineEdit[] {
  const scores = lcsScores(oldLines, newLines);
  const edits: LineEdit[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex] ?? "";
    const newLine = newLines[newIndex] ?? "";
    if (oldLine === newLine) {
      edits.push({ kind: "equal", text: oldLine });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    const dropOld = scores[oldIndex + 1]?.[newIndex] ?? 0;
    const dropNew = scores[oldIndex]?.[newIndex + 1] ?? 0;
    if (dropOld >= dropNew) {
      edits.push({ kind: "delete", text: oldLine });
      oldIndex += 1;
    } else {
      edits.push({ kind: "insert", text: newLine });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    edits.push({ kind: "delete", text: oldLines[oldIndex] ?? "" });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    edits.push({ kind: "insert", text: newLines[newIndex] ?? "" });
    newIndex += 1;
  }
  return edits;
}

function lcsScores(oldLines: readonly string[], newLines: readonly string[]): number[][] {
  const scores = Array.from({ length: oldLines.length + 1 }, () =>
    Array<number>(newLines.length + 1).fill(0),
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const row = scores[oldIndex];
      const below = scores[oldIndex + 1];
      if (row === undefined || below === undefined) {
        continue;
      }
      if (oldLines[oldIndex] === newLines[newIndex]) {
        row[newIndex] = (below[newIndex + 1] ?? 0) + 1;
      } else {
        row[newIndex] = Math.max(below[newIndex] ?? 0, row[newIndex + 1] ?? 0);
      }
    }
  }
  return scores;
}
