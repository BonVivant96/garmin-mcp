import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import dotenv from "dotenv";
import { getGarminClient } from "./garmin.js";

dotenv.config();

const PORT = process.env.PORT || 3000;

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "garmin-mcp",
  version: "1.0.0",
});

// ─── Lookup tables ─────────────────────────────────────────────────────────────

const SPORT_TYPES = {
  running:           { sportTypeId: 1,  sportTypeKey: "running" },
  cycling:           { sportTypeId: 2,  sportTypeKey: "cycling" },
  swimming:          { sportTypeId: 5,  sportTypeKey: "lap_swimming" },
  strength_training: { sportTypeId: 13, sportTypeKey: "strength_training" },
  cardio:            { sportTypeId: 17, sportTypeKey: "cardio_training" },
};

const STEP_TYPE = {
  warmup:   { id: 1, intensity: "WARMUP"   },
  cooldown: { id: 2, intensity: "COOLDOWN" },
  interval: { id: 3, intensity: "ACTIVE"   },
  recovery: { id: 4, intensity: "RECOVERY" },
  rest:     { id: 5, intensity: "REST"     },
};

const TARGET_TYPE = {
  none:        { id: 1,  key: "no.target"    },
  cadence:     { id: 3,  key: "cadence"      },
  heart_rate:  { id: 4,  key: "heart.rate"   },
  pace:        { id: 6,  key: "pace.zone"    },
  power:       { id: 11, key: "power.zone"   },
};

// ─── Tool: list_activities ────────────────────────────────────────────────────

server.tool(
  "list_activities",
  "List recent Garmin activities. Returns summaries including sport type, start time, duration, distance, and average heart rate.",
  {
    limit: z.number().int().min(1).max(100).default(20)
      .describe("Number of activities to return"),
    start: z.number().int().min(0).default(0)
      .describe("Pagination offset (0 = most recent)"),
  },
  async ({ limit, start }) => {
    const g = await getGarminClient();
    const activities = await g.getActivities(start, limit);
    return { content: [{ type: "text", text: JSON.stringify(activities, null, 2) }] };
  }
);

// ─── Tool: get_activity ───────────────────────────────────────────────────────

server.tool(
  "get_activity",
  "Get full details for a specific Garmin activity — splits, laps, HR zones, power, cadence, etc.",
  {
    activity_id: z.number().int()
      .describe("Garmin activity ID (visible in the Garmin Connect URL after /activity/)"),
  },
  async ({ activity_id }) => {
    const g = await getGarminClient();
    const activity = await g.getActivity({ activityId: activity_id });
    return { content: [{ type: "text", text: JSON.stringify(activity, null, 2) }] };
  }
);

// ─── Tool: list_workouts ──────────────────────────────────────────────────────

server.tool(
  "list_workouts",
  "List saved workout plans from Garmin Connect. Returns workout IDs, names, sport types, and step counts.",
  {
    limit: z.number().int().min(1).max(100).default(20)
      .describe("Number of workouts to return"),
    start: z.number().int().min(0).default(0)
      .describe("Pagination offset"),
  },
  async ({ limit, start }) => {
    const g = await getGarminClient();
    const workouts = await g.getWorkouts(start, limit);
    return { content: [{ type: "text", text: JSON.stringify(workouts, null, 2) }] };
  }
);

// ─── Tool: get_workout ────────────────────────────────────────────────────────

server.tool(
  "get_workout",
  "Get full details for a specific saved workout plan, including all steps, targets, and durations.",
  {
    workout_id: z.number().int().describe("Garmin workout ID"),
  },
  async ({ workout_id }) => {
    const g = await getGarminClient();
    const workout = await g.getWorkoutDetail({ workoutId: workout_id });
    return { content: [{ type: "text", text: JSON.stringify(workout, null, 2) }] };
  }
);

// ─── Tool: create_workout ─────────────────────────────────────────────────────

server.tool(
  "create_workout",
  `Create a new structured workout in Garmin Connect.

Each step has a type (warmup/interval/recovery/rest/cooldown), an end condition (time, distance, or open/lap-button), and an optional target (heart rate, pace, power, or cadence range).

Example step descriptions:
  - Warmup 10 min:         { type: "warmup",   duration_type: "time",     duration_seconds: 600 }
  - Run 5 km:              { type: "interval", duration_type: "distance",  distance_meters: 5000 }
  - Z3 HR for 20 min:      { type: "interval", duration_type: "time",     duration_seconds: 1200, target: { type: "heart_rate", low: 130, high: 150 } }
  - Recovery until ready:  { type: "recovery", duration_type: "open" }
  - Cooldown 5 min:        { type: "cooldown", duration_type: "time",     duration_seconds: 300 }`,
  {
    name: z.string().describe("Workout name, e.g. 'Tuesday threshold run'"),
    sport: z.enum(Object.keys(SPORT_TYPES)).describe("Sport type"),
    description: z.string().optional().describe("Optional workout description"),
    steps: z.array(
      z.object({
        type: z.enum(Object.keys(STEP_TYPE)).describe("Step type"),
        duration_type: z.enum(["time", "distance", "open"])
          .describe("What ends the step: time, distance, or open (lap button)"),
        duration_seconds: z.number().optional()
          .describe("Duration in seconds — required when duration_type is 'time'"),
        distance_meters: z.number().optional()
          .describe("Distance in metres — required when duration_type is 'distance'"),
        target: z.object({
          type: z.enum(Object.keys(TARGET_TYPE)).default("none"),
          low: z.number().optional()
            .describe("Lower bound: bpm / sec·km⁻¹ pace / watts / rpm"),
          high: z.number().optional()
            .describe("Upper bound"),
        }).optional().describe("Optional target range — omit for no target"),
        notes: z.string().optional().describe("Step description shown on the watch"),
      })
    ).min(1).describe("Ordered array of workout steps"),
  },
  async ({ name, sport, description, steps }) => {
    const g = await getGarminClient();
    const sportType = SPORT_TYPES[sport];

    const workoutSteps = steps.map((step, i) => {
      const endCondition =
        step.duration_type === "time"
          ? { conditionTypeId: 2, conditionTypeKey: "time" }
          : step.duration_type === "distance"
          ? { conditionTypeId: 3, conditionTypeKey: "distance" }
          : { conditionTypeId: 1, conditionTypeKey: "lap.button" };

      const endConditionValue =
        step.duration_type === "time"     ? (step.duration_seconds ?? null)
        : step.duration_type === "distance" ? (step.distance_meters ?? null)
        : null;

      const tgt   = step.target;
      const tType = TARGET_TYPE[tgt?.type ?? "none"];

      return {
        stepId:           i + 1,
        stepOrder:        i + 1,
        childStepId:      null,
        stepType:         { stepTypeId: STEP_TYPE[step.type].id, stepTypeKey: step.type },
        intensity:        STEP_TYPE[step.type].intensity,
        description:      step.notes ?? "",
        endCondition,
        endConditionValue,
        endConditionCompare:       null,
        endConditionZone:          null,
        preferredEndConditionUnit: null,
        targetType:    { workoutTargetTypeId: tType.id, workoutTargetTypeKey: tType.key },
        targetValueOne: tgt && tgt.type !== "none" ? (tgt.low  ?? null) : null,
        targetValueTwo: tgt && tgt.type !== "none" ? (tgt.high ?? null) : null,
      };
    });

    const payload = {
      workoutName: name,
      description: description ?? "",
      sportType,
      workoutSegments: [{
        segmentOrder: 1,
        sportType,
        workoutSteps,
      }],
    };

    const result = await g.addWorkout(payload);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── Tool: get_calendar ───────────────────────────────────────────────────────

server.tool(
  "get_calendar",
  "Get the Garmin training calendar for a given month. Returns all scheduled workouts, activities, and notes for each day.",
  {
    year:  z.number().int().min(2000).max(2100).describe("Year, e.g. 2025"),
    month: z.number().int().min(1).max(12).describe("Month (1 = January … 12 = December)"),
  },
  async ({ year, month }) => {
    const g = await getGarminClient();
    // garmin-connect uses 0-indexed months
    const calendar = await g.getCalendar(year, month - 1);
    return { content: [{ type: "text", text: JSON.stringify(calendar, null, 2) }] };
  }
);

// ─── Tool: schedule_workout ───────────────────────────────────────────────────

server.tool(
  "schedule_workout",
  "Schedule a saved workout to a specific date in the Garmin training calendar. Use list_workouts to find the workout ID first.",
  {
    workout_id: z.number().int().describe("Garmin workout ID"),
    date: z.string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
      .describe("Date to schedule the workout (YYYY-MM-DD)"),
  },
  async ({ workout_id, date }) => {
    const g = await getGarminClient();
    const result = await g.scheduleWorkout({ workoutId: workout_id }, date);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── Tool: delete_workout ─────────────────────────────────────────────────────

server.tool(
  "delete_workout",
  "Permanently delete a saved workout from Garmin Connect. This cannot be undone. Use list_workouts to find the workout ID first.",
  {
    workout_id: z.number().int().describe("Garmin workout ID to delete"),
  },
  async ({ workout_id }) => {
    const g = await getGarminClient();
    await g.deleteWorkout({ workoutId: workout_id });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ deleted: true, workoutId: workout_id }),
      }],
    };
  }
);

// ─── Express + SSE transport ──────────────────────────────────────────────────

const app = express();
const transports = {}; // sessionId → SSEServerTransport

// Health check — also useful to verify the ngrok tunnel is alive
app.get("/health", (_, res) =>
  res.json({ status: "ok", server: "garmin-mcp", tools: 8 })
);

// Claude.ai opens this endpoint to start an MCP session
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports[transport.sessionId];
    console.log(`Session closed: ${transport.sessionId}`);
  });

  console.log(`New session:    ${transport.sessionId}`);
  await server.connect(transport);
});

// Claude.ai sends tool calls to this endpoint
app.post("/messages", express.json(), async (req, res) => {
  const transport = transports[req.query.sessionId];
  if (!transport) {
    return res.status(404).json({ error: "Session not found" });
  }
  await transport.handlePostMessage(req, res);
});

app.listen(PORT, () => {
  console.log(`\nGarmin MCP server running`);
  console.log(`  Local:  http://localhost:${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  SSE:    http://localhost:${PORT}/sse`);
  console.log(`\nConnect ngrok: ngrok http ${PORT}`);
  console.log(`Then paste the https URL into Claude.ai settings → Integrations\n`);
});
