// A small JSON Schema subset validator (draft 2020-12 keywords this harness uses) and a JSONC
// reader for wrangler.jsonc. Dependency-free so the preflight runs before `pnpm install`.

const KEYWORDS = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "required",
  "properties",
  "additionalProperties",
  "propertyNames",
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

/** Returns a list of `path: message` errors. Messages never include the offending value. */
export function validate(schema, value, root = schema, path = "$") {
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) throw new Error(`Unsupported schema keyword ${key} at ${path}`);
  }
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//, "");
    const target = root.$defs?.[name];
    if (!target) throw new Error(`Unresolved $ref ${schema.$ref}`);
    return validate(target, value, root, path);
  }
  const errors = [];
  if (schema.type && !matchesType(schema.type, value)) {
    return [`${path}: expected ${[].concat(schema.type).join(" or ")}`];
  }
  if (schema.const !== undefined && value !== schema.const)
    errors.push(`${path}: unexpected value`);
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${schema.enum.map(String).join(", ")}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path}: does not match the required format`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: below ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: above ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: needs at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: allows at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      errors.push(`${path}: items must be unique`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validate(schema.items, item, root, `${path}[${i}]`));
      });
    }
  }
  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}: missing ${key}`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${safeKey(key)}`;
      if (schema.propertyNames) {
        errors.push(...validate(schema.propertyNames, key, root, `${childPath}(name)`));
      }
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        errors.push(...validate(schema.properties[key], child, root, childPath));
      } else if (schema.additionalProperties === false) {
        errors.push(`${childPath}: not allowed`);
      } else if (isPlainObject(schema.additionalProperties)) {
        errors.push(...validate(schema.additionalProperties, child, root, childPath));
      }
    }
  }
  return errors;
}

function matchesType(type, value) {
  return [].concat(type).some((t) => {
    if (t === "object") return isPlainObject(value);
    if (t === "array") return Array.isArray(value);
    if (t === "integer") return Number.isInteger(value);
    if (t === "number") return typeof value === "number" && Number.isFinite(value);
    if (t === "null") return value === null;
    return typeof value === t;
  });
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys are echoed in error paths, so clip anything odd rather than print it whole. */
function safeKey(key) {
  return /^[A-Za-z0-9_$-]{1,64}$/.test(key) ? key : "<invalid-key>";
}

/** Parses JSON with comments and trailing commas, as wrangler.jsonc allows. */
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(dropTrailingCommas(out));
}

function dropTrailingCommas(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, i + 1);
    } else if (ch === "," && /^\s*[}\]]/.test(text.slice(i + 1))) {
      // skip the trailing comma
    } else {
      out += ch;
    }
  }
  return out;
}
