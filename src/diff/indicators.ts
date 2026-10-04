const GENERATED_PATHS: readonly RegExp[] = [
  /(^|\/)dist\//u,
  /(^|\/)build\//u,
  /(^|\/)coverage\//u,
  /(^|\/)generated\//u,
  /\.min\.(?:js|css)$/u,
  /\.generated\./u,
  /\.(?:js|css)\.map$/u,
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock)$/u,
];

export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATHS.some((pattern) => pattern.test(path));
}

export function isBinaryPatch(patch: string): boolean {
  return patch.startsWith("Binary files ");
}
