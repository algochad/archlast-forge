import { fileURLToPath } from "node:url";

export function nativePath(file: string): string {
    return fileURLToPath(new URL(`../native/${file}`, import.meta.url));
}
