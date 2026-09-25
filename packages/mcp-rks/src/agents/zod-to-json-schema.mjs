/**
 * Zod-to-JSON-Schema converter for Anthropic tool definitions.
 *
 * Converts the subset of Zod types used in agent tool schemas
 * to JSON Schema compatible with the Anthropic tools API.
 * Deliberately minimal — handles what we actually use, not all of Zod.
 */

/**
 * Convert a Zod schema to JSON Schema.
 * @param {import('zod').ZodType} schema
 * @returns {object} JSON Schema object
 */
export function zodToJsonSchema(schema) {
  if (!schema || !schema._def) {
    throw new Error('zodToJsonSchema: expected a Zod schema');
  }
  return convertDef(schema._def);
}

function convertDef(def) {
  const typeName = def.typeName;

  switch (typeName) {
    case 'ZodObject':
      return convertObject(def);
    case 'ZodString':
      return convertString(def);
    case 'ZodNumber':
      return convertNumber(def);
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodArray':
      return { type: 'array', items: convertDef(def.type._def) };
    case 'ZodOptional':
      return convertDef(def.innerType._def);
    case 'ZodDefault':
      return { ...convertDef(def.innerType._def), default: def.defaultValue() };
    case 'ZodNullable':
      return convertDef(def.innerType._def);
    case 'ZodLiteral':
      return { type: typeof def.value, enum: [def.value] };
    case 'ZodEffects':
      // .transform(), .refine(), etc — unwrap to inner type
      return convertDef(def.schema._def);
    default:
      // Fallback for unknown types — return empty object schema
      return {};
  }
}

function convertObject(def) {
  const properties = {};
  const required = [];

  if (def.shape) {
    const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
    for (const [key, value] of Object.entries(shape)) {
      const fieldDef = value._def;
      properties[key] = convertDef(fieldDef);

      // Add description from .describe()
      if (fieldDef.description) {
        properties[key].description = fieldDef.description;
      } else if (fieldDef.typeName === 'ZodOptional' && fieldDef.innerType._def.description) {
        properties[key].description = fieldDef.innerType._def.description;
      }

      // Track required fields (not optional, not default)
      if (fieldDef.typeName !== 'ZodOptional' && fieldDef.typeName !== 'ZodDefault') {
        required.push(key);
      }
    }
  }

  const result = { type: 'object', properties };
  if (required.length > 0) {
    result.required = required;
  }
  return result;
}

function convertString(def) {
  const result = { type: 'string' };
  if (def.checks) {
    for (const check of def.checks) {
      if (check.kind === 'min') result.minLength = check.value;
      if (check.kind === 'max') result.maxLength = check.value;
    }
  }
  return result;
}

function convertNumber(def) {
  const result = { type: 'number' };
  if (def.checks) {
    for (const check of def.checks) {
      if (check.kind === 'int') result.type = 'integer';
      if (check.kind === 'min') result.minimum = check.value;
      if (check.kind === 'max') result.maximum = check.value;
    }
  }
  return result;
}
