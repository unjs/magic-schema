import type { PluginObj } from '@babel/core'
import * as t from '@babel/types'
import { Schema } from '../types'

function getType (e: t.Expression, getCode: (loc: t.SourceLocation) => string) {
  switch (e.type) {
    case 'TypeCastExpression':
    case 'TSAsExpression':
      return getCode(e.typeAnnotation.loc)

    case 'StringLiteral':
      return 'string'

    case 'BooleanLiteral':
      return 'boolean'

    case 'BigIntLiteral':
      return 'BigInt'

    case 'DecimalLiteral':
    case 'NumericLiteral':
      return 'number'

    case 'NullLiteral':
      return 'null'

    case 'RegExpLiteral':
      return 'RegExp'

    case 'NewExpression':
      return e.callee.type === 'Identifier' ? e.callee.name : 'any'

    case 'ArrayExpression': {
      const types = Array.from(new Set(e.elements.map(el => t.isExpression(el) && getType(el, getCode)))).filter(Boolean)
      return `Array<${types.join(' | ')}>`
    }

    case 'TupleExpression': {
      const types = e.elements.map(el => t.isExpression(el) ? getType(el, getCode) : 'any')
      return `[${types.join(', ')}]`
    }

    case 'AssignmentExpression':
      return getType(e.right, getCode)

    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return 'Function'

    case 'ObjectExpression':
      return 'Record<any, any>'
  }
  return 'any'
}

export default function babelPluginUntyped () {
  return <PluginObj>{
    visitor: {
      ObjectProperty (p) {
        if (p.node.leadingComments) {
          const schema = parseJSDocs(
            p.node.leadingComments
              .filter(c => c.type === 'CommentBlock')
              .map(c => c.value)
          )

          if (p.node.value.type === 'ObjectExpression') {
            const schemaProp = p.node.value.properties.find(prop =>
              ('key' in prop) && prop.key.type === 'Identifier' && prop.key.name === '$schema'
            )
            if (schemaProp && 'value' in schemaProp) {
              if (schemaProp.value.type === 'ObjectExpression') {
                // Object has $schema
                schemaProp.value.properties.push(...schemaToPropsAst(schema))
              } else {
                // Object has $schema which is not an object
                // SKIP
              }
            } else {
              // Object has not $schema
              p.node.value.properties.unshift(buildObjectPropery('$schema', schemaToAst(schema)))
            }
          } else {
            // Literal value
            p.node.value = t.objectExpression([
              t.objectProperty(t.identifier('$default'), p.node.value),
              t.objectProperty(t.identifier('$schema'), schemaToAst(schema))
            ])
          }
          p.node.leadingComments = []
        }
      },
      FunctionDeclaration (p) {
        // TODO: find associated jsdoc
        const schema = parseJSDocs(
          (p.node.leadingComments || [])
            .filter(c => c.type === 'CommentBlock')
            .map(c => c.value)
        )

        schema.type = 'function'
        schema.args = []

        const code = this.file.code.split('\n')
        const getCode = (loc: t.SourceLocation) => code[loc.start.line - 1].slice(loc.start.column, loc.end.column).trim() || ''

        // Extract arguments
        p.node.params.forEach((param, index) => {
          if (param.loc.end.line !== param.loc.start.line) {
            return null
          }
          if (param.type !== 'AssignmentPattern' && param.type !== 'Identifier') {
            return null
          }
          const _param = param.type === 'AssignmentPattern' ? param.left : param
          const arg = {
            // @ts-ignore TODO
            name: _param.name || ('arg' + index),
            type: getCode(_param.loc).split(':').slice(1).join(':').trim() || undefined,
            default: undefined,
            // @ts-ignore TODO
            optional: _param.optional || undefined
          }

          if (param.type === 'AssignmentPattern') {
            if (param.right.type === 'TSAsExpression') {
              arg.default = getCode(param.right.expression.loc)
            } else {
              arg.default = getCode(param.right.loc)
            }
            if (param.right.type === 'TSAsExpression' && param.right.typeAnnotation.type === 'TSTypeReference' && param.right.typeAnnotation.typeName.type === 'Identifier' && param.right.typeAnnotation.typeName.name === 'const') {
              // Ignore 'as const' as it's not properly a type on its own
              switch (param.right.expression.type) {
                case 'BigIntLiteral':
                case 'BooleanLiteral':
                case 'DecimalLiteral':
                case 'NullLiteral':
                case 'NumericLiteral':
                case 'RegExpLiteral':
                case 'StringLiteral':
                  arg.type = arg.type || getCode(param.right.expression.loc)
                  break

                default:
                  arg.type = arg.type || getType(param.right.expression, getCode)
              }
            } else {
              arg.type = arg.type || getType(param.right, getCode)
            }
          }
          schema.args.push(arg)
        })

        if (p.node.returnType?.type === 'TSTypeAnnotation') {
          schema.returns = getCode(p.node.returnType.typeAnnotation.loc)
        }

        // Replace function with it's meta
        const schemaAst = t.objectExpression([
          buildObjectPropery('$schema', t.objectExpression(schemaToPropsAst(schema)))
        ])
        p.replaceWith(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(p.node.id.name), schemaAst)]))
      }
    }
  }
}

function parseJSDocs (input: string | string[]): Schema {
  const schema: Schema = {}

  const lines = [].concat(input)
    .map(c => c.split('\n').map(l => l.replace(/^[\s*]+|[\s*]$/, '')))
    .flat()
    .filter(Boolean)

  const comments: string[] = []
  while (lines.length && !lines[0].startsWith('@')) {
    comments.push(lines.shift())
  }
  if (comments.length === 1) {
    schema.title = comments[0]
  } else if (comments.length > 1) {
    schema.title = comments[0]
    schema.description = comments.splice(1).join('\n')
  }

  if (lines.length) {
    schema.tags = []
    for (const line of lines) {
      schema.tags.push(line)
    }
  }

  return schema
}

function valToAstLiteral (val: any) {
  if (typeof val === 'string') {
    return t.stringLiteral(val)
  }
  if (typeof val === 'boolean') {
    return t.booleanLiteral(val)
  }
  if (typeof val === 'number') {
    return t.numericLiteral(val)
  }
  return null
}

function buildObjectPropsAst (obj: any) {
  const props = []
  for (const key in obj) {
    const astLiteral = valToAstLiteral(obj[key])
    if (astLiteral) {
      props.push(t.objectProperty(t.identifier(key), astLiteral))
    }
  }
  return props
}

function buildObjectPropery (name, val) {
  return t.objectProperty(t.identifier(name), val)
}

function schemaToPropsAst (schema: Schema) {
  const props = buildObjectPropsAst(schema)

  if (schema.args) {
    props.push(buildObjectPropery('args', t.arrayExpression(schema.args.map(
      arg => t.objectExpression(buildObjectPropsAst(arg))
    ))))
  }

  if (schema.tags) {
    props.push(buildObjectPropery('tags', t.arrayExpression(schema.tags.map(
      tag => t.stringLiteral(tag)
    ))))
  }

  return props
}

function schemaToAst (schema) {
  return t.objectExpression(schemaToPropsAst(schema))
}
