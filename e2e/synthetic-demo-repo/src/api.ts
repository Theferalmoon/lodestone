// SPDX-License-Identifier: Apache-2.0
// HTTP API surface. Wraps auth + db with request/response shapes that the
// JS server (web/server.js) registers with Express. Members here should
// cluster together; bridges into auth.ts and db.ts via login/verify calls.

import { login, logout, verifyToken } from "./auth.js";
import { insertUser, findUserById, type User } from "./db.js";
import { ApiError, log, nowIso } from "./util.js";

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export function handleRegister(req: RegisterRequest): ApiResponse<User> {
  log("api", `register ${req.email}`);
  try {
    const user: User = {
      id: `u_${Date.now().toString(36)}`,
      email: req.email,
      passwordHash: `hash:${req.password.length}`,
      createdAt: nowIso(),
    };
    insertUser(user);
    return { ok: true, data: user };
  } catch (err) {
    throw new ApiError(`register failed: ${(err as Error).message}`, 400);
  }
}

export function handleLogin(req: LoginRequest): ApiResponse<{ token: string }> {
  log("api", `login ${req.email}`);
  try {
    const result = login(req.email, req.password);
    return { ok: true, data: { token: result.token } };
  } catch (err) {
    throw new ApiError(`login failed: ${(err as Error).message}`, 401);
  }
}

export function handleLogout(token: string): ApiResponse<{ ok: true }> {
  log("api", `logout ${token}`);
  logout(token);
  return { ok: true, data: { ok: true } };
}

export function handleProfile(token: string): ApiResponse<User> {
  log("api", `profile ${token}`);
  const user = verifyToken(token);
  const fresh = findUserById(user.id);
  if (!fresh) {
    throw new ApiError("user not found", 404);
  }
  return { ok: true, data: fresh };
}

export function handleHealth(): ApiResponse<{ ok: true; ts: string }> {
  return { ok: true, data: { ok: true, ts: nowIso() } };
}
