// SPDX-License-Identifier: Apache-2.0
// Additional Express router — imports express from a second file so the
// §11 framework-detector's ≥2-files-required threshold is satisfied.

import express from "express";

export function createAdminRouter() {
  const router = express.Router();
  router.get("/admin/ping", (req, res) => {
    res.json({ ok: true, scope: "admin" });
  });
  router.get("/admin/version", (req, res) => {
    res.json({ ok: true, version: "0.0.1" });
  });
  return router;
}
