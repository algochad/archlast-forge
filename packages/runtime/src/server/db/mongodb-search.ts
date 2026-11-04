// The words of a search index on MongoDB, kept out of mongodb.ts so that DocStore doesn't load the driver.

/** The search words of a document, for the array a search index is served from: lowercase, one entry for each time a word occurs (the ranking counts them). */
export const searchWords = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** The field that holds a search index's words. */
export const searchField = (index: string) => `_s_${index}`;
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
