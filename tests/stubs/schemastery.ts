interface Schema {
  kind: string
  value?: unknown
  shape?: Record<string, Schema>
  default(value: unknown): Schema
  min(value: number): Schema
  step(value: number): Schema
}

function schema(kind: string, shape?: Record<string, Schema>): Schema {
  const result: Schema = {
    kind,
    ...shape === undefined ? {} : { shape },
    default(value) { this.value = value; return this },
    min() { return this },
    step() { return this },
  }
  return result
}

export default {
  object: (shape: Record<string, Schema>) => schema('object', shape),
  string: () => schema('string'),
  number: () => schema('number'),
}
