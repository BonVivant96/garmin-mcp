import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import express from "express";
import { z } from "zod";
import dotenv from "dotenv";
import crypto from "node:crypto";
import { completeGarminMfa, getGarminClient } from "./garmin.js";

dotenv.config();

const PORT = process.env.PORT || 3000;
// PUBLIC_URL must be your ngrok URL — set this in .env before connecting Claude.ai
// e.g. PUBLIC_URL=https://xxxx.ngrok-free.app
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

// ─── In-memory OAuth provider (personal server — auto-approves everything) ────

const clients = new Map();  // clientId → client record
const codes   = new Map();  // authCode → { clientId, redirectUri, codeChallenge }
const tokens  = new Map();  // accessToken → { clientId, expiresAt }

const oauthProvider = {
  clientsStore: {
    async getClient(clientId) {
      return clients.get(clientId);
    },
    async registerClient(client) {
      const registered = {
        ...client,
        client_id: client.client_id || crypto.randomUUID(),
        client_id_issued_at: client.client_id_issued_at || Math.floor(Date.now() / 1000),
      };
      if (registered.token_endpoint_auth_method !== "none" && !registered.client_secret) {
        registered.client_secret = crypto.randomBytes(32).toString("hex");
      }
      clients.set(registered.client_id, registered);
      console.log(`✓ OAuth client registered: ${registered.client_id}`);
      return registered;
    },
  },

  // Skip the login page — auto-approve and redirect immediately.
  async authorize(client, params, res) {
    const code = crypto.randomBytes(16).toString("hex");
    codes.set(code, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
    });
    const url = new URL(params.redirectUri);
    url.searchParams.set("code", code);
    if (params.state) url.searchParams.set("state", params.state);
    console.log(`✓ Auto-authorized: ${client.client_id}`);
    res.redirect(url.toString());
  },

  async challengeForAuthorizationCode(client, code) {
    const stored = codes.get(code);
    if (!stored || stored.clientId !== client.client_id) {
      throw new Error("Invalid authorization code");
    }
    return stored.codeChallenge;
  },

  async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri) {
    const stored = codes.get(code);
    if (
      !stored ||
      stored.clientId !== client.client_id ||
      stored.redirectUri !== redirectUri
    ) {
      throw new Error("Invalid authorization code");
    }
    codes.delete(code);
    const accessToken = crypto.randomBytes(32).toString("hex");
    const expiresIn = 86400 * 30;
    tokens.set(accessToken, {
      clientId: client.client_id,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    });
    console.log(`✓ Token issued for: ${client.client_id}`);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
    };
  },

  async verifyAccessToken(token) {
    const info = tokens.get(token);
    if (!info) throw new InvalidTokenError("Invalid or expired token");
    return { token, clientId: info.clientId, scopes: [], expiresAt: info.expiresAt };
  },

  async revokeToken(_client, request) {
    tokens.delete(request.token);
  },
};

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
  none:       { id: 1,  key: "no.target"  },
  cadence:    { id: 3,  key: "cadence"    },
  heart_rate: { id: 4,  key: "heart.rate" },
  pace:       { id: 6,  key: "pace.zone"  },
  power:      { id: 11, key: "power.zone" },
};

// ─── MCP server factory (one per request for stateless transport) ─────────────

function createMcpServer() {
  const server = new McpServer({ name: "garmin-mcp", version: "1.0.0" });

  server.tool("complete_garmin_mfa",
    "Complete a pending Garmin Connect login using the one-time MFA code sent by Garmin. Call another Garmin tool first to start login and request the code.",
    {
      code: z.string().regex(/^\d{6}$/, "Must be a 6-digit Garmin MFA code"),
    },
    async ({ code }) => {
      const result = await completeGarminMfa(code);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool("list_activities",
    "List recent Garmin activities. Returns summaries including sport type, start time, duration, distance, and average heart rate.",
    {
      limit: z.number().int().min(1).max(100).default(20).describe("Number of activities to return"),
      start: z.number().int().min(0).default(0).describe("Pagination offset (0 = most recent)"),
    },
    async ({ limit, start }) => {
      const g = await getGarminClient();
      const activities = await g.getActivities(start, limit);
      return { content: [{ type: "text", text: JSON.stringify(activities, null, 2) }] };
    }
  );

  server.tool("get_activity",
    "Get full details for a specific Garmin activity — splits, laps, HR zones, power, cadence, etc.",
    { activity_id: z.number().int().describe("Garmin activity ID (visible in the Garmin Connect URL after /activity/)") },
    async ({ activity_id }) => {
      const g = await getGarminClient();
      const activity = await g.getActivity({ activityId: activity_id });
      return { content: [{ type: "text", text: JSON.stringify(activity, null, 2) }] };
    }
  );

  server.tool("list_workouts",
    "List saved workout plans from Garmin Connect. Returns workout IDs, names, sport types, and step counts.",
    {
      limit: z.number().int().min(1).max(100).default(20).describe("Number of workouts to return"),
      start: z.number().int().min(0).default(0).describe("Pagination offset"),
    },
    async ({ limit, start }) => {
      const g = await getGarminClient();
      const workouts = await g.getWorkouts(start, limit);
      return { content: [{ type: "text", text: JSON.stringify(workouts, null, 2) }] };
    }
  );

  server.tool("get_workout",
    "Get full details for a specific saved workout plan, including all steps, targets, and durations.",
    { workout_id: z.number().int().describe("Garmin workout ID") },
    async ({ workout_id }) => {
      const g = await getGarminClient();
      const workout = await g.getWorkoutDetail({ workoutId: workout_id });
      return { content: [{ type: "text", text: JSON.stringify(workout, null, 2) }] };
    }
  );

  server.tool("create_workout",
    `Create a new structured workout in Garmin Connect.

Each step has a type (warmup/interval/recovery/rest/cooldown), an end condition (time, distance, or open/lap-button), and an optional target (heart rate, pace, power, or cadence range).

Example steps:
  - Warmup 10 min:     { type: "warmup",   duration_type: "time",     duration_seconds: 600 }
  - Run 5 km:          { type: "interval", duration_type: "distance",  distance_meters: 5000 }
  - Z3 HR for 20 min:  { type: "interval", duration_type: "time",     duration_seconds: 1200, target: { type: "heart_rate", low: 130, high: 150 } }
  - Open recovery:     { type: "recovery", duration_type: "open" }
  - Cooldown 5 min:    { type: "cooldown", duration_type: "time",     duration_seconds: 300 }`,
    {
      name: z.string().describe("Workout name"),
      sport: z.enum(Object.keys(SPORT_TYPES)).describe("Sport type"),
      description: z.string().optional().describe("Optional description"),
      steps: z.array(z.object({
        type: z.enum(Object.keys(STEP_TYPE)).describe("Step type"),
        duration_type: z.enum(["time", "distance", "open"]).describe("What ends the step"),
        duration_seconds: z.number().optional().describe("Duration in seconds (when duration_type is 'time')"),
        distance_meters: z.number().optional().describe("Distance in metres (when duration_type is 'distance')"),
        target: z.object({
          type: z.enum(Object.keys(TARGET_TYPE)).default("none"),
          low: z.number().optional(),
          high: z.number().optional(),
        }).optional().describe("Optional target range"),
        notes: z.string().optional(),
      })).min(1).describe("Ordered array of workout steps"),
    },
    async ({ name, sport, description, steps }) => {
      const g = await getGarminClient();
      const sportType = SPORT_TYPES[sport];
      const workoutSteps = steps.map((step, i) => {
        const endCondition =
          step.duration_type === "time"     ? { conditionTypeId: 2, conditionTypeKey: "time" }
          : step.duration_type === "distance" ? { conditionTypeId: 3, conditionTypeKey: "distance" }
          :                                     { conditionTypeId: 1, conditionTypeKey: "lap.button" };
        const endConditionValue =
          step.duration_type === "time"     ? (step.duration_seconds ?? null)
          : step.duration_type === "distance" ? (step.distance_meters ?? null)
          : null;
        const tgt   = step.target;
        const tType = TARGET_TYPE[tgt?.type ?? "none"];
        return {
          stepId: i + 1, stepOrder: i + 1, childStepId: null,
          stepType:  { stepTypeId: STEP_TYPE[step.type].id, stepTypeKey: step.type },
          intensity: STEP_TYPE[step.type].intensity,
          description: step.notes ?? "",
          endCondition, endConditionValue,
          endConditionCompare: null, endConditionZone: null, preferredEndConditionUnit: null,
          targetType:    { workoutTargetTypeId: tType.id, workoutTargetTypeKey: tType.key },
          targetValueOne: tgt && tgt.type !== "none" ? (tgt.low  ?? null) : null,
          targetValueTwo: tgt && tgt.type !== "none" ? (tgt.high ?? null) : null,
        };
      });
      const result = await g.addWorkout({
        workoutName: name, description: description ?? "", sportType,
        workoutSegments: [{ segmentOrder: 1, sportType, workoutSteps }],
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool("get_calendar",
    "Get the Garmin training calendar for a given month.",
    {
      year:  z.number().int().min(2000).max(2100).describe("Year, e.g. 2025"),
      month: z.number().int().min(1).max(12).describe("Month (1 = January … 12 = December)"),
    },
    async ({ year, month }) => {
      const g = await getGarminClient();
      const calendar = await g.getScheduledWorkouts(year, month);
      return { content: [{ type: "text", text: JSON.stringify(calendar, null, 2) }] };
    }
  );

  server.tool("schedule_workout",
    "Schedule a saved workout to a specific date in the Garmin training calendar.",
    {
      workout_id: z.number().int().describe("Garmin workout ID"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").describe("Date to schedule"),
    },
    async ({ workout_id, date }) => {
      const g = await getGarminClient();
      const result = await g.scheduleWorkout(workout_id, date);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool("delete_workout",
    "Permanently delete a saved workout from Garmin Connect. This cannot be undone.",
    { workout_id: z.number().int().describe("Garmin workout ID to delete") },
    async ({ workout_id }) => {
      const g = await getGarminClient();
      await g.deleteWorkout({ workoutId: workout_id });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true, workoutId: workout_id }) }] };
    }
  );

  return server;
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Mount all OAuth 2.0 endpoints:
//   GET  /.well-known/oauth-protected-resource
//   GET  /.well-known/oauth-authorization-server
//   POST /register
//   GET  /authorize
//   POST /token
//   POST /revoke
app.use(
  mcpAuthRouter({
    provider:   oauthProvider,
    issuerUrl:  new URL(PUBLIC_URL),
    baseUrl:    new URL(PUBLIC_URL),
  })
);

app.get("/", (_, res) =>
  res.json({ name: "garmin-mcp", status: "ok", endpoints: { health: "/health", mcp: "/mcp" } })
);

app.get("/health", (_, res) =>
  res.json({ status: "ok", server: "garmin-mcp", tools: 9 })
);

// MCP endpoint — requires valid bearer token issued by the OAuth flow above
async function handleMcpPost(req, res) {
  const server    = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null });
    }
  }
  res.on("close", async () => { await transport.close(); await server.close(); });
}

const requireMcpAuth = requireBearerAuth({
  verifier: oauthProvider,
  requiredScopes: [],
  resourceMetadataUrl: `${PUBLIC_URL}/.well-known/oauth-protected-resource`,
});

// Support clients configured with either the recommended /mcp URL or tunnel root.
app.post("/mcp", requireMcpAuth, handleMcpPost);
app.post("/", requireMcpAuth, handleMcpPost);

app.get("/mcp",    (_, res) => res.status(405).end());
app.delete("/mcp", (_, res) => res.status(405).end());

app.listen(PORT, () => {
  console.log(`\nGarmin MCP server running`);
  console.log(`  Local:     http://localhost:${PORT}`);
  console.log(`  Public:    ${PUBLIC_URL}/mcp`);
  console.log(`\nIMPORTANT: PUBLIC_URL in .env must match your ngrok URL`);
  console.log(`  1. Run: ngrok http ${PORT}`);
  console.log(`  2. Copy the https://xxxx.ngrok-free.app URL`);
  console.log(`  3. Set PUBLIC_URL=https://xxxx.ngrok-free.app in .env`);
  console.log(`  4. Restart this server`);
  console.log(`  5. Add https://xxxx.ngrok-free.app/mcp to Claude.ai integrations\n`);
});
