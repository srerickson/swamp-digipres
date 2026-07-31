import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  formatVersionName,
  nextVersionName,
  parseVersionName,
  sortVersionNames,
} from "./version.ts";

Deno.test("parseVersionName reads number and padding convention", () => {
  assertEquals(parseVersionName("v1"), { name: "v1", number: 1, padding: 0 });
  assertEquals(parseVersionName("v10"), {
    name: "v10",
    number: 10,
    padding: 0,
  });
  assertEquals(parseVersionName("v0002"), {
    name: "v0002",
    number: 2,
    padding: 4,
  });
});

Deno.test("parseVersionName rejects malformed and zero versions", () => {
  for (const name of ["1", "vv1", "v", "va", "v0", "v00", "v1.1", ""]) {
    assertEquals(parseVersionName(name), null, name);
  }
});

Deno.test("nextVersionName preserves the object's convention", () => {
  assertEquals(nextVersionName("v1"), "v2");
  assertEquals(nextVersionName("v9"), "v10");
  assertEquals(nextVersionName("v0001"), "v0002");
  assertEquals(nextVersionName("v0009"), "v0010");
});

Deno.test("nextVersionName refuses to widen a padded convention (E011)", () => {
  // v0999 is the last version a 4-wide padded object can name.
  assertThrows(() => nextVersionName("v0999"));
});

Deno.test("formatVersionName round-trips padding", () => {
  assertEquals(formatVersionName(3, 0), "v3");
  assertEquals(formatVersionName(3, 4), "v0003");
});

Deno.test("sortVersionNames orders numerically, not lexically", () => {
  assertEquals(sortVersionNames(["v10", "v2", "v1"]), ["v1", "v2", "v10"]);
});
