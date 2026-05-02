// SPDX-License-Identifier: Apache-2.0
// Top-level barrel — re-exports the API surface so the JS server can grab
// everything from one place. Keeps the import graph tidy for the parser.

export {
  handleRegister,
  handleLogin,
  handleLogout,
  handleProfile,
  handleHealth,
} from "./api.js";
export { AppError, AuthError, DbError, ApiError, log } from "./util.js";
