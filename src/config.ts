import { z } from "zod";

const configSchema = z.object({
  cookie: z.string().min(1, "IDRIVE_COOKIE must not be empty"),
});

/** The validated runtime configuration for the server. */
export type Config = z.infer<typeof configSchema>;

/**
 * Loads and validates the server's configuration from environment variables.
 * Exists so every entrypoint (the MCP server, tests, scripts) reads config the
 * same validated way instead of touching `process.env` directly.
 *
 * @returns the validated config, currently just the iDrive session cookie.
 * @throws {Error} if `IDRIVE_COOKIE` is unset or empty — the message names the
 *   missing variable but never includes its value.
 * @example
 * ```ts
 * process.env.IDRIVE_COOKIE = "JSESSIONID=abc; SES_TOKEN=eyJ...";
 * const config = loadConfig();
 * // config.cookie === "JSESSIONID=abc; SES_TOKEN=eyJ..."
 * ```
 */
export function loadConfig(): Config {
  const result = configSchema.safeParse({
    cookie: process.env.IDRIVE_COOKIE,
  });

  if (!result.success) {
    throw new Error(
      "Missing or invalid IDRIVE_COOKIE environment variable. " +
        "Set it to the full Cookie header value from a logged-in idrive.com session " +
        "(see .env.example for how to obtain it).",
    );
  }

  return result.data;
}
