#!/usr/bin/env node
import { spawn } from "node:child_process";
import { getuid } from "node:process";

const label = process.env.DEVSPACE_LAUNCH_AGENT_LABEL ?? "com.liheng.devspace";
const uid = typeof getuid === "function" ? getuid() : Number(process.env.UID);
if (!Number.isInteger(uid)) {
  throw new Error("Unable to determine the current user ID.");
}

const command = `sleep 2; /bin/launchctl kickstart -k gui/${uid}/${label}`;
const child = spawn("/bin/sh", ["-c", command], {
  detached: true,
  stdio: "ignore",
});
child.unref();

console.log(JSON.stringify({
  status: "RESTART_SCHEDULED",
  label,
  delaySeconds: 2,
}, null, 2));
