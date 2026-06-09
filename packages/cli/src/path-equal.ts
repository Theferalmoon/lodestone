// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Resolve the deepest existing ancestor of `p` via realpath, then re-append
 * non-existing trailing segments. Handles runtime paths that may not exist yet
 * and platform symlink quirks such as macOS `/var` -> `/private/var`.
 */
export function realpathDeepestExisting(p: string): string {
  let head = path.resolve(p);
  let tail = "";
  while (head !== path.dirname(head)) {
    try {
      const real = realpathSync(head);
      return tail === "" ? real : path.join(real, tail);
    } catch {
      tail = tail === "" ? path.basename(head) : path.join(path.basename(head), tail);
      head = path.dirname(head);
    }
  }
  return head;
}

export function pathsEqual(a: string, b: string): boolean {
  if (a === b) return true;
  return realpathDeepestExisting(a) === realpathDeepestExisting(b);
}
