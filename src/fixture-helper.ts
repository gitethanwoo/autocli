/**
 * Test-only loader for the private FaithBase schema fixture. The file is a
 * real production schema export and is intentionally NOT committed to the
 * public repo — fixture-bound suites skip when it's absent, synthetic-schema
 * suites always run.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRawSchema } from "./introspect.js";
import type { SchemaIR } from "./types.js";

export const FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/faithbase-schema.json", import.meta.url),
);

export const hasFixture = existsSync(FIXTURE_PATH);

export function loadFixtureRaw(): string {
  return readFileSync(FIXTURE_PATH, "utf8");
}

export function loadFixtureIR(): SchemaIR {
  return parseRawSchema(loadFixtureRaw());
}

export const EMPTY_IR: SchemaIR = { tables: [], schemaHash: "no-fixture" };
