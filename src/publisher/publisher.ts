import { unimplemented } from "../shared/unimplemented.js";
import type { ReviewPublisher } from "./types.js";

export function createUnimplementedPublisher(): ReviewPublisher {
  return {
    publish: unimplemented("ReviewPublisher.publish"),
  };
}
