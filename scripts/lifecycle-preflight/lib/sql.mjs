// Basin (R2 SQL) is a read-only query engine over R2 Data Catalog (Iceberg) tables: one SELECT
// statement per request. Anything that writes, deletes or changes state must run in an external
// Iceberg engine instead, so generated or hand-written Basin SQL is checked for it here.

/** Keywords that change data, schema or session state wherever they appear. */
const WRITE_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "UPSERT",
  "CREATE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "COPY",
  "CALL",
  "EXECUTE",
  "VACUUM",
  "ATTACH",
  "DETACH",
  "PRAGMA",
];
/** Keywords that are only statements at the start (REPLACE and SET are also SQL functions/clauses). */
const LEADING_ONLY = ["REPLACE", "SET", "USE", "BEGIN", "COMMIT", "ROLLBACK", "OPTIMIZE", "LOAD"];

/** Returns machine-safe problem codes for one Basin query; an empty list means read-only. */
export function inspectBasinSql(sql) {
  const problems = [];
  const code = stripLiterals(String(sql));
  const statements = code
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length === 0) return ["empty"];
  if (statements.length > 1) problems.push("multiple-statements");
  for (const statement of statements) {
    const words = statement.toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? [];
    if (words[0] !== "SELECT" && words[0] !== "WITH") problems.push(`leading:${words[0] ?? "?"}`);
    if (LEADING_ONLY.includes(words[0])) problems.push(`unsupported:${words[0]}`);
    for (const word of new Set(words)) {
      if (WRITE_KEYWORDS.includes(word)) problems.push(`unsupported:${word}`);
    }
  }
  return [...new Set(problems)];
}

/** Removes comments, string literals and quoted identifiers so keywords inside them don't count. */
function stripLiterals(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (ch === "'" || ch === '"' || ch === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === ch && sql[i + 1] === ch) i += 2;
        else if (sql[i] === ch) break;
        else i++;
      }
      i++;
      out += " _lit_ ";
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
