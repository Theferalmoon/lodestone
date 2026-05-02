import { helper } from "./helper";

export function topLevel(a: number, b: number): number {
  return helper(a) + b;
}

export class User {
  greet(): string {
    return helper("hi");
  }
  login(token: string): boolean {
    return token.length > 0;
  }
}
