/**
 * Resolve the real `defineTool` when the dsh package graph is visible to this
 * bundle, otherwise use a compatible dependency-free compiler.
 *
 * A linked workspace bundle is imported from its own directory, so bare
 * `@deepseek-ai/*` imports are not on its Node resolution path in a packaged
 * desktop install. The fallback implements the same schema-DSL subset and the
 * same argument validation boundary used by this plugin's three string tools.
 */

const ANNOTATIONS = ['description', 'title', 'default', 'examples'];

function schemaError(path, reason) {
  const error = new Error(`unsupported schema at ${path}: ${reason}`);
  error.code = 'UNSUPPORTED_SCHEMA';
  return error;
}

function copyAnnotations(source, target) {
  for (const key of ANNOTATIONS) {
    if (Object.hasOwn(source, key)) target[key] = source[key];
  }
}

function compileValue(node, path, allowRequired = false) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw schemaError(path, 'expected an object');
  }
  if (Object.hasOwn(node, 'required') && allowRequired && node.required !== true) {
    throw schemaError(path, 'required must be true when present');
  }
  if (Object.hasOwn(node, 'oneOf')) {
    throw schemaError(path, 'oneOf is not used by this plugin');
  }
  const type = node.type;
  const output = {};
  copyAnnotations(node, output);
  if (type === 'object') {
    if (typeof node.additionalProperties !== 'boolean') {
      throw schemaError(path, 'additionalProperties must be explicitly true or false');
    }
    output.type = 'object';
    output.additionalProperties = node.additionalProperties;
    if (node.properties !== undefined) {
      const compiled = compilePropertyMap(node.properties, `${path}.properties`);
      output.properties = compiled.properties;
      if (compiled.required.length) output.required = compiled.required;
    }
    return output;
  }
  if (type === 'array') {
    output.type = 'array';
    if (node.items !== undefined) output.items = compileValue(node.items, `${path}.items`, false);
    return output;
  }
  if (!['string', 'number', 'integer', 'boolean', 'null'].includes(type)) {
    throw schemaError(path, 'unsupported type');
  }
  output.type = type;
  if (Array.isArray(node.enum)) output.enum = [...node.enum];
  if (Object.hasOwn(node, 'const')) output.const = node.const;
  return output;
}

function compilePropertyMap(input, path) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw schemaError(path, 'expected a property map');
  }
  const properties = {};
  const required = [];
  for (const [key, property] of Object.entries(input)) {
    if (property?.required === true) required.push(key);
    properties[key] = compileValue(property, `${path}.${key}`, true);
  }
  return { properties, required };
}

function validateValue(schema, value, path, violations) {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      violations.push(`${path} must be an object`);
      return;
    }
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) violations.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) violations.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) validateValue(child, value[key], `${path}.${key}`, violations);
    }
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`${path} must be an array`);
      return;
    }
    if (schema.items) {
      value.forEach((entry, index) => validateValue(schema.items, entry, `${path}[${index}]`, violations));
    }
    return;
  }
  if (schema.type === 'string' && typeof value !== 'string') violations.push(`${path} must be a string`);
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) violations.push(`${path} must be a number`);
  if (schema.type === 'integer' && (!Number.isInteger(value))) violations.push(`${path} must be an integer`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') violations.push(`${path} must be a boolean`);
  if (schema.type === 'null' && value !== null) violations.push(`${path} must be null`);
}

class LocalToolArgsError extends Error {
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`);
    this.name = 'ToolArgsError';
    this.code = 'INVALID_ARGS';
    this.violations = violations;
  }
}

function fallbackDefineTool(options) {
  const parameters = compilePropertyMap(options.parameters, 'parameters');
  const parameterSchema = {
    type: 'object',
    properties: parameters.properties,
    ...(parameters.required.length ? { required: parameters.required } : {}),
  };
  const outputSchema = compileValue(options.output.schema, 'schema', false);
  const userExecute = options.execute;
  const userRender = options.output.render;
  const userConcurrency = options.isConcurrencySafe;

  const validate = (args) => {
    const violations = [];
    validateValue(parameterSchema, args, '', violations);
    return violations;
  };

  const tool = {
    name: options.name,
    description: options.description,
    parameters: parameterSchema,
    output: {
      schema: outputSchema,
      render(args, value) {
        return userRender(args, value);
      },
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      const violations = validate(args);
      if (violations.length) throw new LocalToolArgsError(violations);
      return userExecute(args, exec);
    },
  };
  if (userConcurrency) {
    tool.isConcurrencySafe = (args) => validate(args).length === 0 && userConcurrency(args);
  }
  return tool;
}

export async function resolveDefineTool() {
  try {
    const module = await import('@deepseek-ai/dsh-tools');
    if (typeof module.defineTool !== 'function') {
      throw new Error('@deepseek-ai/dsh-tools does not export defineTool');
    }
    return module.defineTool;
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return fallbackDefineTool;
  }
}
