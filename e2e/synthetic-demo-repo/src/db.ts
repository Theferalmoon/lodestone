// SPDX-License-Identifier: Apache-2.0
// Database access layer. Imports util.ts (logger + error). Exposes a User
// model + query helpers that auth.ts and api.ts both call into — anchor
// symbols for the cluster + impact tools.

import { DbError, log, assertNonEmpty } from "./util.js";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface Session {
  token: string;
  userId: string;
  expiresAt: string;
}

let users: User[] = [];
let sessions: Session[] = [];

export function findUserByEmail(email: string): User | null {
  log("db", `findUserByEmail(${email})`);
  return users.find((u) => u.email === email) ?? null;
}

export function findUserById(id: string): User | null {
  log("db", `findUserById(${id})`);
  return users.find((u) => u.id === id) ?? null;
}

export function insertUser(user: User): void {
  assertNonEmpty(user.email, "email");
  assertNonEmpty(user.passwordHash, "passwordHash");
  if (findUserByEmail(user.email) !== null) {
    throw new DbError(`user with email ${user.email} already exists`);
  }
  users.push(user);
  log("db", `inserted user ${user.id}`);
}

export function insertSession(session: Session): void {
  sessions.push(session);
  log("db", `inserted session ${session.token}`);
}

export function findSessionByToken(token: string): Session | null {
  return sessions.find((s) => s.token === token) ?? null;
}

export function deleteSession(token: string): void {
  const before = sessions.length;
  sessions = sessions.filter((s) => s.token !== token);
  if (sessions.length === before) {
    throw new DbError(`session ${token} not found`);
  }
  log("db", `deleted session ${token}`);
}

export function clearAll(): void {
  users = [];
  sessions = [];
  log("db", "cleared all storage");
}
