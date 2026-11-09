export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const initials = (name: string) => name.split(" ").map((w) => w[0]).join("");
export const upper = (s: string) => s.toUpperCase();
