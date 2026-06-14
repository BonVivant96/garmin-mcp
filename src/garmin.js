import garminConnect from "garmin-connect";

const { GarminConnect } = garminConnect;

let client = null;

/**
 * Returns a logged-in GarminConnect client, creating and caching one on first call.
 * Throws a clear error if credentials are missing or login fails.
 */
export async function getGarminClient() {
  if (client) return client;

  const { GARMIN_EMAIL, GARMIN_PASSWORD } = process.env;
  if (!GARMIN_EMAIL || !GARMIN_PASSWORD) {
    throw new Error(
      "GARMIN_EMAIL and GARMIN_PASSWORD must be set in your .env file"
    );
  }

  client = new GarminConnect({ username: GARMIN_EMAIL, password: GARMIN_PASSWORD });

  try {
    await client.login(GARMIN_EMAIL, GARMIN_PASSWORD);
    console.log("✓ Authenticated with Garmin Connect");
  } catch (err) {
    client = null; // allow retry on next call
    throw new Error(`Garmin login failed: ${err.message}`);
  }

  return client;
}
