// SPDX-License-Identifier: Apache-2.0
// Authentication subsystem. login() / logout() / verifyToken() form an
// internally cohesive call graph that should land in the same Louvain
// community. Bridges to db.ts and util.ts.

import {
  findUserByEmail,
  findUserById,
  findSessionByToken,
  insertSession,
  deleteSession,
  type User,
} from "./db.js";
import { AuthError, log, nowIso, assertNonEmpty } from "./util.js";

function hashPassword(password: string): string {
  // NOT real crypto — fixture only.
  let h = 0;
  for (let i = 0; i < password.length; i++) {
    h = (h * 31 + password.charCodeAt(i)) | 0;
  }
  return `hash:${h}`;
}

function generateToken(userId: string): string {
  return `tok:${userId}:${Date.now().toString(36)}`;
}

export function checkPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

export function login(email: string, password: string): { token: string; user: User } {
  assertNonEmpty(email, "email");
  assertNonEmpty(password, "password");
  log("auth", `login attempt for ${email}`);
  const user = findUserByEmail(email);
  if (!user) {
    throw new AuthError("invalid credentials");
  }
  if (!checkPassword(password, user.passwordHash)) {
    throw new AuthError("invalid credentials");
  }
  const token = generateToken(user.id);
  insertSession({
    token,
    userId: user.id,
    expiresAt: nowIso(),
  });
  log("auth", `login OK for ${email}`);
  return { token, user };
}

export function logout(token: string): void {
  log("auth", `logout token ${token}`);
  deleteSession(token);
}

export function verifyToken(token: string): User {
  log("auth", `verifyToken ${token}`);
  const session = findSessionByToken(token);
  if (!session) {
    throw new AuthError("session not found");
  }
  const user = findUserById(session.userId);
  if (!user) {
    throw new AuthError("user not found");
  }
  return user;
}
