// SPDX-License-Identifier: Apache-2.0
// Express server that wires the API handlers to HTTP routes. Imports
// express + the TS API barrel — exercises the §11 framework-detector
// (≥2 importing files would normally be required, but we document the
// expectation in FIXTURE_MANIFEST and accept a single-file detection here
// since the express handler convention is canonical).

import express from "express";
import {
  handleRegister,
  handleLogin,
  handleLogout,
  handleProfile,
  handleHealth,
} from "../src/index.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (req, res) => {
    res.json(handleHealth());
  });

  app.post("/register", (req, res) => {
    res.json(handleRegister(req.body));
  });

  app.post("/login", (req, res) => {
    res.json(handleLogin(req.body));
  });

  app.post("/logout", (req, res) => {
    const token = req.headers["x-token"];
    res.json(handleLogout(String(token ?? "")));
  });

  app.get("/profile", (req, res) => {
    const token = req.headers["x-token"];
    res.json(handleProfile(String(token ?? "")));
  });

  return app;
}

export function startServer(port) {
  const app = createApp();
  return app.listen(port);
}
