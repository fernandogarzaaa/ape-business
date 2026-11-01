import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VENDOR_JOBS } from "./vendor-config.mjs";

// Local checkout paths for the 4 source repos on this machine.
const LOCAL = {
  genesis: "C:\\Users\\garza\\genesis_repo",
  eve: "E:\\workspace\\experience-validation-engine",
  adam: "C:\\Users\\garza\\ADAM",
  skein: "E:\\skein",
};

const { execFileSync } = await import("node:child_process");
const params = [];
for (const j of VENDOR_JOBS) {
  if (LOCAL[j.name] && existsSync(LOCAL[j.name])) {
    params.push("--src-" + j.name, LOCAL[j.name]);
  }
}
execFileSync("node", [join(dirname(fileURLToPath(import.meta.url)), "sync-vendors.mjs"), ...params], { stdio: "inherit" });
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log("vendor complete — see vendors/vendor-report.json");
