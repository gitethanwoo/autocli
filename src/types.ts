/**
 * Shapes produced by Convex's `SchemaDefinition.export()` — verified against
 * a real convex 1.39 project. This is the wire format we introspect.
 */
export type ValidatorJson =
  | { type: "string" }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "any" }
  | { type: "int64" }
  | { type: "bytes" }
  | { type: "id"; tableName: string }
  | { type: "literal"; value: string | number | boolean }
  | { type: "array"; value: ValidatorJson }
  | { type: "union"; value: ValidatorJson[] }
  | {
      type: "object";
      value: Record<string, { fieldType: ValidatorJson; optional: boolean }>;
    }
  | {
      type: "record";
      keys: ValidatorJson;
      values: { fieldType: ValidatorJson; optional: boolean };
    };

export interface RawIndexJson {
  indexDescriptor: string;
  fields: string[];
}

export interface RawSearchIndexJson {
  indexDescriptor: string;
  searchField: string;
  filterFields: string[];
}

export interface RawTableJson {
  tableName: string;
  indexes: RawIndexJson[];
  searchIndexes: RawSearchIndexJson[];
  vectorIndexes: { indexDescriptor: string }[];
  documentType: ValidatorJson | null;
}

export interface RawSchemaExport {
  tables: RawTableJson[];
}

/** Summarized field kind used for CLI flag coercion and formatting decisions. */
export type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "id"
  | "enum"
  | "array"
  | "object"
  | "record"
  | "any"
  | "unknown";

export interface FieldIR {
  name: string;
  optional: boolean;
  /** true when the field's union includes v.null() */
  nullable: boolean;
  kind: FieldKind;
  /** target table when kind === "id" */
  refTable?: string;
  /** literal values when kind === "enum" */
  enumValues?: (string | number | boolean)[];
}

export interface IndexIR {
  name: string;
  fields: string[];
}

export interface SearchIndexIR {
  name: string;
  searchField: string;
  filterFields: string[];
}

export interface TableIR {
  name: string;
  fields: FieldIR[];
  indexes: IndexIR[];
  searchIndexes: SearchIndexIR[];
  /** top-level document type was not a plain object (e.g. union) */
  irregularShape: boolean;
}

export interface SchemaIR {
  tables: TableIR[];
  /** sha256 of the raw export string, for drift detection */
  schemaHash: string;
}

// ---------------------------------------------------------------------------
// Spec: the committed, human/agent-editable artifact that drives the CLI.
// ---------------------------------------------------------------------------

export interface FilterSpec {
  /** CLI flag, e.g. "--organization-id" (stored without dashes) */
  flag: string;
  field: string;
  kind: FieldKind;
  refTable?: string;
  enumValues?: (string | number | boolean)[];
}

export interface RelationSpec {
  table: string;
  /** the id field on the child table pointing at the parent */
  field: string;
  /** index on the child table whose first field is `field` (makes the lookup cheap) */
  index: string;
  /** the CLI flag on the child table's list command for this fk */
  flag: string;
}

export interface SearchSpec {
  index: string;
  searchField: string;
  /** filter flags usable with this search (subset of table filters) */
  filterFields: string[];
}

export interface TableSpec {
  name: string;
  /** one-line description shown in help. Generated default; edit freely. */
  description: string;
  /** optional operator hint (cost/safety/when-to-use). Filled by the interview. */
  hint?: string;
  /** columns shown in list view, in order. _id is always appended last. */
  identityFields: string[];
  /** fields stripped server-side, never returned */
  redactedFields: string[];
  /** long-text / structured fields elided in lists, truncated in detail */
  blobFields: string[];
  filters: FilterSpec[];
  /** indexes available for the runtime query planner */
  indexes: IndexIR[];
  belongsTo: { field: string; table: string }[];
  hasMany: RelationSpec[];
  search: SearchSpec[];
  /** field used to label this table's rows when referenced from elsewhere */
  labelField?: string;
}

export interface WorkflowSpec {
  title: string;
  /** ordered, copy-pasteable steps with a short trailing comment each */
  steps: { cmd: string; note: string }[];
  /** true until a human/agent confirms it in the finishing interview */
  todo?: boolean;
}

export interface SpecDefaults {
  rowLimit: number;
  maxRowLimit: number;
  /** approximate output budget per command, in tokens (chars/4 heuristic) */
  outputTokenBudget: number;
  countCap: number;
}

export interface AutocliSpec {
  specVersion: 1;
  adapter: "convex";
  projectName: string;
  schemaHash: string;
  defaults: SpecDefaults;
  workflows: WorkflowSpec[];
  tables: Record<string, TableSpec>;
}
