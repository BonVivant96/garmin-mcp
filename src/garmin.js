import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

let bridge = null;
let nextRequestId = 1;
const pending = new Map();

function startBridge() {
  const python = process.env.GARMIN_PYTHON || (process.platform === "win32" ? "py" : "python3");
  const args = process.platform === "win32" && !process.env.GARMIN_PYTHON
    ? ["-3.13", path.resolve("src/garmin_bridge.py")]
    : [path.resolve("src/garmin_bridge.py")];

  bridge = spawn(python, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });

  readline.createInterface({ input: bridge.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });

  bridge.on("exit", (code) => {
    bridge = null;
    for (const request of pending.values()) {
      request.reject(new Error(`Garmin bridge exited with code ${code}`));
    }
    pending.clear();
  });
}

function callBridge(method, args = []) {
  if (!bridge) startBridge();
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    bridge.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
  });
}

const garminClient = {
  getActivities: (start, limit) => callBridge("get_activities", [start, limit]),
  getActivity: ({ activityId }) => callBridge("get_activity", [String(activityId)]),
  getWorkouts: (start, limit) => callBridge("get_workouts", [start, limit]),
  getWorkoutDetail: ({ workoutId }) => callBridge("get_workout_by_id", [workoutId]),
  addWorkout: (workout) => callBridge("upload_workout", [workout]),
  deleteWorkout: ({ workoutId }) => callBridge("delete_workout", [workoutId]),
  getScheduledWorkouts: (year, month) => callBridge("get_scheduled_workouts", [year, month]),
  scheduleWorkout: (workoutId, date) => callBridge("schedule_workout", [workoutId, date]),
};

export async function getGarminClient() {
  return garminClient;
}

export async function completeGarminMfa(code) {
  return callBridge("complete_mfa", [code]);
}

export async function getGarminMfaStatus() {
  return callBridge("get_mfa_status");
}

export async function resendGarminMfa() {
  return callBridge("resend_mfa");
}
