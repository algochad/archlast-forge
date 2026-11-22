import { expect, test } from "bun:test";
import {
  parseDevices,
  reverseMappings,
  selectDevice,
  waydroidAddress,
} from "../src/mobile/android";

test("ADB selection prefers a ready USB device over unauthorized devices, emulators and TCP devices", () => {
  const devices = parseDevices(
    "List of devices attached\n" +
      "emulator-5554 device product:sdk\n" +
      "192.168.0.5:5555 device transport_id:3\n" +
      "locked unauthorized usb:1-1\n" +
      "offline offline usb:1-2\n" +
      "restricted no permissions (check udev)\n" +
      "pixel device usb:1-3 model:Pixel\n",
  );
  expect(devices.map(({ state }) => state)).toEqual([
    "device",
    "device",
    "unauthorized",
    "offline",
    "no permissions",
    "device",
  ]);
  expect(selectDevice(devices)?.serial).toBe("pixel");
  expect(selectDevice(devices, "emulator-5554")?.serial).toBe("emulator-5554");
  expect(() => selectDevice(devices, "locked")).toThrow("unauthorized");
  expect(() =>
    selectDevice([
      ...devices,
      { serial: "spare", state: "device", detail: "usb:1-4" },
    ]),
  ).toThrow("--device");
});

test("ADB reverse parsing preserves which device port maps to which host port", () => {
  expect([
    ...reverseMappings(
      "UsbFfs tcp:8081 tcp:49123\nlocalabstract:foo localabstract:bar\ntcp:3000 tcp:3000\n",
    ),
  ]).toEqual([
    ["tcp:8081", "tcp:49123"],
    ["tcp:3000", "tcp:3000"],
  ]);
});

test("Waydroid selection uses the reported address and ADB port", () => {
  expect(waydroidAddress("Session: RUNNING\nIP address: 192.168.240.112")).toBe(
    "192.168.240.112:5555",
  );
  expect(waydroidAddress("IP addr: 192.168.240.112\nADB port: 5557")).toBe(
    "192.168.240.112:5557",
  );
  expect(waydroidAddress("ADB endpoint: [fd00::1]:5559")).toBe(
    "[fd00::1]:5559",
  );
  expect(waydroidAddress("IP address: UNKNOWN")).toBeUndefined();
});
