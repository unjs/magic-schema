import type { Schema, JSType } from '../types'
import { escapeKey, unique } from '../utils'

const TYPE_MAP: Record<JSType, string> = {
  array: 'any[]',
  bigint: 'bigint',
  boolean: 'boolean',
  number: 'number',
  object: 'any',
  any: 'any',
  string: 'string',
  symbol: 'Symbol',
  function: 'Function'
}

const SCHEMA_KEYS = [
  'items',
  'default',
  'resolve',
  'properties',
  'title',
  'description',
  '$schema',
  'type',
  'tags',
  'args',
  'id'
]

export function generateTypes (schema: Schema, name: string = 'Untyped') {
  return `interface ${name} {\n  ` + _genTypes(schema, ' ').join('\n ') + '\n}'
}

function _genTypes (schema: Schema, spaces: string): string[] {
  const buff: string[] = []

  for (const key in schema.properties) {
    const val = schema.properties[key] as Schema
    buff.push(...generateJSDoc(val))
    if (val.type === 'object') {
      buff.push(`${escapeKey(key)}: {`, ..._genTypes(val, spaces + ' '), '},\n')
    } else {
      let type: string
      if (val.type === 'array') {
        const _type = getTsType(val.items.type)
        type = _type.includes('|') ? `(${_type})[]` : `${_type}[]`
      } else if (val.type === 'function') {
        type = genFunctionType(val)
      } else {
        type = getTsType(val.type)
      }
      buff.push(`${escapeKey(key)}: ${type},\n`)
    }
  }

  if (buff.length) {
    const last = buff.pop() || ''
    buff.push(last.substr(0, last.length - 1))
  } else {
    buff.push('[key: string]: any')
  }

  return buff.map(i => spaces + i)
}

function getTsType (type: JSType | JSType[]): string {
  if (Array.isArray(type)) {
    return unique(type.map(t => getTsType(t))).join(' | ') || 'any'
  }
  return (type && TYPE_MAP[type]) || 'any'
}

export function genFunctionType (schema: Schema) {
  const args = schema.args.map((arg) => {
    let argStr = arg.name
    if (arg.optional) {
      argStr += '?'
    }
    if (arg.type) {
      argStr += ': ' + arg.type
    }
    if (arg.default) {
      argStr += ' = ' + arg.default
    }
    return argStr
  })

  return `(${args.join(', ')}) => {}`
}

function generateJSDoc (schema: Schema): string[] {
  let buff = []

  if (schema.title) {
    buff.push(schema.title)
  }

  if (schema.description) {
    buff.push(schema.description)
  }

  if (
    schema.type !== 'object' && schema.type !== 'any' &&
    !(Array.isArray(schema.default) && schema.default.length === 0)
  ) {
    const stringified = JSON.stringify(schema.default)
    if (stringified) {
      buff.push(`@default ${stringified.replace(/\*\//g, '*\\/')}`)
    }
  }

  for (const key in schema) {
    if (!SCHEMA_KEYS.includes(key)) {
      buff.push('', `@${key} ${schema[key]}`)
    }
  }

  if (Array.isArray(schema.tags)) {
    for (const tag of schema.tags) {
      buff.push('', tag)
    }
  }

  // Normalize new lines in values
  buff = buff.map(i => i.split('\n')).flat()

  if (buff.length) {
    return buff.length === 1
      ? ['/** ' + buff[0] + ' */']
      : ['/**', ...buff.map(i => ` * ${i}`), '*/']
  }

  return []
}
