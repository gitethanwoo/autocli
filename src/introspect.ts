import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FieldIR,
  RawSchemaExport,
  RawTableJson,
  SchemaIR,
  TableIR,
  ValidatorJson,
} from "./types.js";

const BEGIN = "__AUTOCLI_SCHEMA_BEGIN__";
const END = "__AUTOCLI_SCHEMA_END__";

/**
 * Runs inside the target project via `npx tsx` so the project's own convex
 * package (and any imports schema.ts pulls in) resolve correctly. The schema
 * module may log arbitrary noise on import, so the JSON is fenced with markers.
 */
const LOADER_SOURCE = `
import { pathToFileURL } from "node:url";
const schemaPath = process.argv[2];
import(pathToFileURL(schemaPath).href)
  .then((m) => {
    let s = m.default;
    if (s && typeof s === "object" && "default" in s && s.default) s = s.default;
    if (!s || typeof s.export !== "function") {
      console.error("autocli: convex/schema.ts default export is not a defineSchema() result");
      process.exit(2);
    }
    process.stdout.write("\\n${BEGIN}" + s.export() + "${END}\\n");
  })
  .catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(2);
  });
`;

export class IntrospectError extends Error {}

export function findSchemaFile(projectDir: string): string {
  const candidates = ["convex/schema.ts", "convex/schema.js"];
  for (const c of candidates) {
    const p = join(projectDir, c);
    if (existsSync(p)) return p;
  }
  throw new IntrospectError(
    `No convex/schema.ts found in ${projectDir}. Run autocli from a Convex project root.`,
  );
}

const SPAWN_OPTS = {
  encoding: "utf8" as const,
  maxBuffer: 64 * 1024 * 1024,
  timeout: 120_000,
};

function extractFenced(out: string): string | null {
  const start = out.indexOf(BEGIN);
  const end = out.indexOf(END);
  if (start === -1 || end === -1) return null;
  return out.slice(start + BEGIN.length, end);
}

/**
 * Primary path: bundle schema.ts with esbuild in ESM mode — the same way the
 * Convex CLI evaluates it. This sidesteps CJS/ESM interop failures (e.g. a
 * dependency whose exports map only defines an `import` condition, which
 * breaks when tsx compiles schema.ts as CJS in a non-"type":"module" project).
 */
function resolveEsbuildBin(projectDir: string): string | null {
  // esbuild is a transitive dep of convex; pnpm doesn't hoist its binary, so
  // resolve it through the project's own convex package instead of npx.
  const script =
    "try { console.log(require.resolve('esbuild/bin/esbuild')) } catch { console.log(require.resolve('esbuild/bin/esbuild', {paths:[require('path').dirname(require.resolve('convex/package.json'))]})) }";
  const res = spawnSync("node", ["-e", script], { cwd: projectDir, ...SPAWN_OPTS });
  const out = (res.stdout ?? "").trim();
  return res.status === 0 && out.length > 0 ? out : null;
}

function evalViaEsbuild(projectDir: string, schemaPath: string, dir: string, loaderPath: string): { raw: string | null; err: string } {
  const esbuildBin = resolveEsbuildBin(projectDir);
  if (esbuildBin === null) return { raw: null, err: "esbuild: not resolvable from the project (nor via its convex dependency)" };
  const bundlePath = join(dir, "schema.bundle.mjs");
  const bundle = spawnSync(
    "node",
    [esbuildBin, schemaPath, "--bundle", "--format=esm", "--platform=node", `--outfile=${bundlePath}`, "--log-level=silent"],
    { cwd: projectDir, ...SPAWN_OPTS },
  );
  if (bundle.error || bundle.status !== 0) {
    return { raw: null, err: `esbuild: ${bundle.error?.message ?? (bundle.stderr ?? "").slice(-1000)}` };
  }
  const res = spawnSync("node", [loaderPath, bundlePath], { cwd: projectDir, ...SPAWN_OPTS });
  if (res.error) return { raw: null, err: `node: ${res.error.message}` };
  const raw = extractFenced(res.stdout ?? "");
  if (res.status !== 0 || raw === null) return { raw: null, err: (res.stderr ?? "").slice(-1000) };
  return { raw, err: "" };
}

/** Fallback: evaluate schema.ts directly with tsx in the project. */
function evalViaTsx(projectDir: string, schemaPath: string, loaderPath: string): { raw: string | null; err: string } {
  const res = spawnSync("npx", ["tsx", loaderPath, schemaPath], { cwd: projectDir, ...SPAWN_OPTS });
  if (res.error) return { raw: null, err: `tsx: ${res.error.message}` };
  const raw = extractFenced(res.stdout ?? "");
  if (res.status !== 0 || raw === null) return { raw: null, err: (res.stderr ?? "").slice(-2000) };
  return { raw, err: "" };
}

/** Evaluate the project's schema module and return the raw export() JSON string. */
export function loadRawSchema(projectDir: string): string {
  const schemaPath = findSchemaFile(projectDir);
  const dir = mkdtempSync(join(tmpdir(), "autocli-"));
  const loaderPath = join(dir, "loader.mjs");
  try {
    writeFileSync(loaderPath, LOADER_SOURCE);
    const viaEsbuild = evalViaEsbuild(projectDir, schemaPath, dir, loaderPath);
    if (viaEsbuild.raw !== null) return viaEsbuild.raw;
    const viaTsx = evalViaTsx(projectDir, schemaPath, loaderPath);
    if (viaTsx.raw !== null) return viaTsx.raw;
    throw new IntrospectError(
      `Evaluating convex/schema.ts failed.\n— esbuild bundle path —\n${viaEsbuild.err}\n— tsx path —\n${viaTsx.err}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function parseRawSchema(raw: string): SchemaIR {
  const parsed = JSON.parse(raw) as RawSchemaExport;
  if (!parsed || !Array.isArray(parsed.tables)) {
    throw new IntrospectError("Unexpected schema export shape: missing tables array");
  }
  return {
    tables: parsed.tables.map(toTableIR).sort((a, b) => a.name.localeCompare(b.name)),
    schemaHash: createHash("sha256").update(raw).digest("hex"),
  };
}

export function introspectConvexProject(projectDir: string): SchemaIR {
  return parseRawSchema(loadRawSchema(projectDir));
}

function toTableIR(t: RawTableJson): TableIR {
  const fields: FieldIR[] = [];
  let irregularShape = false;
  const doc = t.documentType;
  if (doc && doc.type === "object") {
    for (const [name, entry] of Object.entries(doc.value)) {
      fields.push(toFieldIR(name, entry.fieldType, entry.optional));
    }
  } else {
    irregularShape = true;
  }
  return {
    name: t.tableName,
    fields,
    indexes: (t.indexes ?? []).map((i) => ({ name: i.indexDescriptor, fields: i.fields })),
    searchIndexes: (t.searchIndexes ?? []).map((s) => ({
      name: s.indexDescriptor,
      searchField: s.searchField,
      filterFields: s.filterFields ?? [],
    })),
    irregularShape,
  };
}

function toFieldIR(name: string, validator: ValidatorJson, optional: boolean): FieldIR {
  const { inner, nullable } = unwrapNull(validator);
  const base: FieldIR = { name, optional, nullable, kind: "unknown" };

  if (inner.length === 0) {
    // field was exactly v.null()
    return { ...base, kind: "unknown" };
  }

  // All-literal union (or single literal) → enum
  if (inner.every((v) => v.type === "literal")) {
    return {
      ...base,
      kind: "enum",
      enumValues: inner.map((v) => (v as { type: "literal"; value: string | number | boolean }).value),
    };
  }

  if (inner.length > 1) {
    // Mixed union: degrade to the common scalar kind if uniform, else unknown
    const kinds = new Set(inner.map((v) => v.type));
    if (kinds.size === 1) {
      const only = inner[0];
      if (only) return { ...toFieldIR(name, only, optional), nullable };
    }
    return { ...base, kind: "unknown" };
  }

  const v = inner[0];
  if (!v) return base;
  switch (v.type) {
    case "string":
      return { ...base, kind: "string" };
    case "number":
    case "int64":
      return { ...base, kind: "number" };
    case "boolean":
      return { ...base, kind: "boolean" };
    case "id":
      return { ...base, kind: "id", refTable: v.tableName };
    case "literal":
      return { ...base, kind: "enum", enumValues: [v.value] };
    case "array":
      return { ...base, kind: "array" };
    case "object":
      return { ...base, kind: "object" };
    case "record":
      return { ...base, kind: "record" };
    case "any":
      return { ...base, kind: "any" };
    default:
      return { ...base, kind: "unknown" };
  }
}

/** Flatten unions and strip v.null() members, reporting nullability. */
function unwrapNull(v: ValidatorJson): { inner: ValidatorJson[]; nullable: boolean } {
  if (v.type !== "union") {
    return v.type === "null" ? { inner: [], nullable: true } : { inner: [v], nullable: false };
  }
  const flat: ValidatorJson[] = [];
  let nullable = false;
  for (const member of v.value) {
    if (member.type === "null") {
      nullable = true;
    } else if (member.type === "union") {
      const sub = unwrapNull(member);
      nullable = nullable || sub.nullable;
      flat.push(...sub.inner);
    } else {
      flat.push(member);
    }
  }
  return { inner: flat, nullable };
}
