import { z } from "zod";

/**
 * Zod schema for a single device entry as returned by iDrive's
 * `getListDevicesForSub` endpoint (see the confirmed example in
 * `docs/api-map.md`) — exists so the response can be validated at the
 * network boundary instead of trusting `unknown` JSON all the way through
 * tool code, and so {@link Device} can be derived from a single source of
 * truth via `z.infer`.
 */
export const deviceSchema = z.object({
  loc: z.string(),
  device_id: z.string(),
  os: z.string(),
  bucket_type: z.string(),
  server_root: z.string(),
  nick_name: z.string(),
  ip: z.string(),
  bucket_ctime: z.string(),
  uniqueId: z.string(),
});

/**
 * A single device backed up under an iDrive account, as listed by the
 * `list_devices` tool.
 *
 * @example
 * ```ts
 * const device: Device = {
 *   loc: "ajc",
 *   device_id: "D01637267159000960219",
 *   os: "Microsoft Windows 7 Professional",
 *   bucket_type: "D",
 *   server_root: "D01637267159000951218",
 *   nick_name: "ACRESSWELL01-D",
 *   ip: "73.203.45.23",
 *   bucket_ctime: "2021/11/18 12:25:59",
 *   uniqueId: "5d964e08bf6240adb46943d486eb33a9",
 * };
 * ```
 * @see deviceSchema
 */
export type Device = z.infer<typeof deviceSchema>;
