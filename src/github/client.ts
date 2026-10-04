import { unimplemented } from "../shared/unimplemented.js";
import type { GitHubClient } from "./types.js";

export function createUnimplementedGitHubClient(): GitHubClient {
  return {
    fetchPullRequest: unimplemented("GitHubClient.fetchPullRequest"),
    fetchFileText: unimplemented("GitHubClient.fetchFileText"),
  };
}
