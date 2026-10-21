import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const listDevices = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    return await ctx.db
      .query("devices")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", identity.subject))
      .collect();
  },
});

export const updateDeviceConfig = mutation({
  args: {
    deviceId: v.id("devices"),
    config: v.object({
      environmentId: v.optional(v.string()),
      threadId: v.optional(v.string()),
      gatewayAccessMode: v.optional(v.union(v.literal("local"), v.literal("tailscale"), v.literal("online"))),
      gatewayUrl: v.optional(v.union(v.string(), v.null())),
      defaultPrompt: v.string(),
      shellCommand: v.optional(v.string()),
      menu: v.array(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.userExternalId !== identity.subject) {
      throw new Error("Device not found");
    }
    await ctx.db.patch(args.deviceId, {
      config: args.config,
      updatedAt: new Date().toISOString(),
    });
    return await ctx.db.get(args.deviceId);
  },
});

export const latestFirmwareRelease = query({
  args: {
    hardwareModel: v.string(),
  },
  handler: async (ctx, args) => {
    const releases = await ctx.db
      .query("firmwareReleases")
      .withIndex("byHardwareModel", (q) => q.eq("hardwareModel", args.hardwareModel))
      .collect();
    return releases.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null;
  },
});
