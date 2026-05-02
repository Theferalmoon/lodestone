import { helper } from "./helper.js";
const fs = require("fs");

export function topLevel(a, b) {
  return helper(a) + b;
}

export class User {
  greet() {
    return helper("hi");
  }
}

void fs;
