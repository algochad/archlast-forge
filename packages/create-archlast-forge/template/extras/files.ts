import { ForgeError, mutation, query, v } from "@archlast-forge/runtime";

/**
 * Step one of an upload: the browser PUTs the file to the returned `uploadUrl`, then saves `storageId`
 * (with another mutation) wherever it belongs. In React, `useUploadFile(api.files.generateUploadUrl)` does both steps.
 */
export const generateUploadUrl = mutation({
  args: { contentType: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await ctx.auth.getUserIdentity())) throw new ForgeError("Sign in to upload files");
    return ctx.storage.generateUploadUrl(args);
  },
});

/** A temporary link to a stored file, or null if it no longer exists. */
export const url = query({
  args: { storageId: v.id("_storage") },
  handler: (ctx, { storageId }) => ctx.storage.getUrl(storageId),
});
