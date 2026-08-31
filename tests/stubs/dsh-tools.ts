/** Preserve definitions while enforcing DSH's implicit parameter-property map contract. */
export function defineTool(options: unknown): unknown {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('tool definition must be an object')
  }
  const parameters = (options as { parameters?: unknown }).parameters
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new TypeError('parameters must be an object of value schemas')
  }
  for (const [name, schema] of Object.entries(parameters)) {
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new TypeError(`parameters.${name} must be a value schema object`)
    }
  }
  return options
}
