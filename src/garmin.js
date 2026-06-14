import garminConnect from "garmin-connect";
import path from "node:path";

const { GarminConnect } = garminConnect;

let client = null;
const DEFAULT_TOKEN_DIR = ".garmin-tokens";

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
  const tokenDir = path.resolve(process.env.GARMIN_TOKEN_DIR || DEFAULT_TOKEN_DIR);

  try {
    try {
      client.loadTokenByFile(tokenDir);
      await client.getUserProfile();
      console.log("✓ Restored Garmin Connect session");
    } catch {
      await client.login(GARMIN_EMAIL, GARMIN_PASSWORD);
      client.exportTokenToFile(tokenDir);
      console.log("✓ Authenticated with Garmin Connect");
    }
  } catch (err) {
    client = null; // allow retry on next call
    throw new Error(
      `Garmin login failed: ${err.message}. ` +
      "The garmin-connect package does not support MFA; verify credentials or temporarily disable MFA for one login so reusable tokens can be saved."
    );
  }

  return client;
}
