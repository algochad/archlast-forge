import { describe, expect, test } from "bun:test";
import { memoizeIntl } from "../src/intl-cache";

memoizeIntl();
memoizeIntl(); // twice is once

describe("formatters are made once per locale and options", () => {
  test("the same arguments give the same formatter, other arguments another, and the output is the formatter's own", () => {
    const a = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
    const b = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
    const c = new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" });
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(a.format(1234.5)).toBe("$1,234.50");
    expect(c.format(1234.5)).toBe("€1,234.50");
    expect(a).toBeInstanceOf(Intl.NumberFormat);
  });

  test("DateTimeFormat follows the time zone given, and the process's when none is", () => {
    const utc = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", timeStyle: "short" });
    const manila = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", timeStyle: "short" });
    expect(utc.format(0)).toBe("12:00 AM");
    expect(manila.format(0)).toBe("8:00 AM");
    const before = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const x = new Intl.DateTimeFormat("en-US", { timeStyle: "short" });
      expect(x.format(0)).toBe("12:00 AM");
      process.env.TZ = "Asia/Manila";
      const y = new Intl.DateTimeFormat("en-US", { timeStyle: "short" });
      expect(y.format(0)).toBe("8:00 AM");
      expect(y).not.toBe(x);
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  test("it works called without new, with static methods, with undefined arguments and with arguments that are not plain data", () => {
    expect(Intl.NumberFormat("en-US").format(1000)).toBe("1,000");
    expect(Intl.NumberFormat.supportedLocalesOf(["en-US"])).toEqual(["en-US"]);
    expect(new Intl.NumberFormat(undefined, undefined)).toBe(new Intl.NumberFormat());
    const locale = new Intl.Locale("en-US");
    const one = new Intl.NumberFormat(locale);
    const two = new Intl.NumberFormat(locale);
    expect(two).not.toBe(one); // an object that is not plain data is not a key
    expect(one.format(5)).toBe("5");
    expect(new Intl.PluralRules("en-US").select(1)).toBe("one");
  });
});
