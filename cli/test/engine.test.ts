// cli/engine.test.ts
import { test, expect } from "bun:test";
import * as engine from "../../index.js";

test("the submission engine is importable", () => {
  for (const fn of ["changeFacebook", "walkForPassword", "taskAvailability",
                    "mineChat", "uidOf", "readProviderBalance",
                    "changePassword", "readAccounts", "checkUid", "resolveUrl"]) {
    expect(typeof (engine as any)[fn]).toBe("function");
  }
  expect(typeof engine.Taskly).toBe("function");
});
