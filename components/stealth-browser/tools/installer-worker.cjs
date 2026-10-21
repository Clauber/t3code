"use strict";
// Runs one operation of the bundled release installer off the server's event loop.
// This file verifies nothing itself: signature, digest and tree checks are the installer's own code.
const { parentPort, workerData } = require("node:worker_threads");
const installer = require("./stealth-browser-installer.cjs");

const OPERATIONS = new Set(["installRelease", "rollbackRelease"]);

(async () => {
  try {
    if (!OPERATIONS.has(workerData.operation)) throw new Error("unknown installer operation");
    const result = await installer[workerData.operation](...workerData.args);
    parentPort.postMessage({ ok: true, result: JSON.parse(JSON.stringify(result)) });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      message: String(error && error.message ? error.message : error),
    });
  }
})();
