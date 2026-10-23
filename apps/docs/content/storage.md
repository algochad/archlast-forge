# File storage

Set `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_REGION`. Any S3-compatible service works. [RustFS](https://rustfs.com) is a good self-hosted choice, and `archlast-forge dev --with s3` runs one for you on `localhost:9000`.

Browsers upload to storage directly, so they must be able to reach it. When the engine reaches storage at a different address than browsers do (a Docker network name, or a dev proxy), set `S3_PUBLIC_ENDPOINT` to the browser-facing address.

File bytes never pass through the engine. Clients upload straight to storage through presigned URLs:

```ts
// convex/files.ts
export const generateUploadUrl = mutation({
  args: { contentType: v.optional(v.string()) },
  handler: (ctx, args) => ctx.storage.generateUploadUrl(args), // { uploadUrl, storageId }
});

export const attach = mutation({
  args: { todoId: v.id("todos"), storageId: v.id("_storage") },
  handler: (ctx, { todoId, storageId }) => ctx.db.patch(todoId, { attachmentId: storageId }),
});

// in a query: a presigned download URL, or null
const url = await ctx.storage.getUrl(todo.attachmentId);
```

```tsx
const upload = useUploadFile(api.files.generateUploadUrl);
const storageId = await upload(file);       // PUTs directly to storage
await attach({ todoId, storageId });
```

`ctx.storage.delete(id)` removes the metadata row in the transaction and deletes the object after it commits. Configure CORS on your bucket so browsers can PUT to it.
