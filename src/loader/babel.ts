import type { ConfigAPI, PluginItem, PluginObj } from "@babel/core";
import * as t from "@babel/types";
import type { Schema, JSType, TypeDescriptor, FunctionArg } from "../types";
import {
  normalizeTypes,
  mergedTypes,
  cachedFn,
  getTypeDescriptor,
} from "../utils";

import { version } from "../../package.json";

type GetCodeFn = (loc: t.SourceLocation | null | undefined) => string;

const babelPluginUntyped: PluginItem = function (
  api: ConfigAPI,
  options: { experimentalFunctions?: boolean },
) {
  const name = "untyped";
  api.cache.using(() => version);

  return <PluginObj>{
    name,
    manipulateOptions(opts: { plugins: Array<{ key: string }> }) {
      // This `untyped` plugin must come before the `transform-typescript` plugin,
      // otherwise the `returnType` annotations will be removed.
      // So put it at the beginning.
      opts.plugins!.sort((a) => (a.key === name ? -1 : 0));
    },
    visitor: {
      VariableDeclaration(p) {
        const declaration = p.node.declarations[0];
        if (
          t.isIdentifier(declaration.id) &&
          (t.isFunctionExpression(declaration.init) ||
            t.isArrowFunctionExpression(declaration.init))
        ) {
          const newDeclaration = t.functionDeclaration(
            declaration.id,
            declaration.init.params,
            t.isBlockStatement(declaration.init.body)
              ? (declaration.init.body as t.BlockStatement)
              : t.blockStatement([t.returnStatement(declaration.init.body)]),
          );
          newDeclaration.returnType = declaration.init.returnType;
          p.replaceWith(newDeclaration);
        }
      },
      ObjectProperty(p) {
        if (p.node.leadingComments && p.node.leadingComments.length > 0) {
          const schema = parseJSDocs(
            p.node.leadingComments
              .filter((c) => c.type === "CommentBlock")
              .map((c) => c.value),
          );

          const valueNode =
            p.node.value.type === "TSTypeAssertion" ||
            p.node.value.type === "TSAsExpression"
              ? p.node.value.expression
              : p.node.value;

          if (valueNode.type === "ObjectExpression") {
            const schemaProp = valueNode.properties.find(
              (prop) =>
                "key" in prop &&
                prop.key.type === "Identifier" &&
                prop.key.name === "$schema",
            );
            if (schemaProp && "value" in schemaProp) {
              if (schemaProp.value.type === "ObjectExpression") {
                // Object has $schema
                schemaProp.value.properties.push(
                  ...(astify(schema) as t.ObjectExpression).properties,
                );
              } else {
                // Object has $schema which is not an object
                // SKIP
              }
            } else {
              // Object has not $schema
              valueNode.properties.unshift(
                ...(astify({ $schema: schema }) as t.ObjectExpression)
                  .properties,
              );
            }
          } else {
            // Literal value
            p.node.value = t.objectExpression([
              t.objectProperty(t.identifier("$default"), valueNode),
              t.objectProperty(t.identifier("$schema"), astify(schema)),
            ]);
          }
          p.node.leadingComments = [];
        }
      },
      FunctionDeclaration(p) {
        const schema = parseJSDocs(
          (p.parent.leadingComments || [])
            .filter((c) => c.type === "CommentBlock")
            .map((c) => c.value),
        );
        schema.type = "function";
        schema.args = [];

        // Experimental functions meta support
        if (
          !options.experimentalFunctions &&
          !schema.tags?.includes("@untyped")
        ) {
          return;
        }

        // Do not add meta to internal functions
        if (
          p.parent.type !== "ExportNamedDeclaration" &&
          p.parent.type !== "ExportDefaultDeclaration"
        ) {
          return;
        }

        const _getLines = cachedFn(() => this.file.code.split("\n"));
        const getCode: GetCodeFn = (loc) => {
          if (!loc) {
            return "";
          }
          const _lines = _getLines();
          return (
            _lines[loc.start.line - 1]
              ?.slice(loc.start.column, loc.end.column)
              .trim() || ""
          );
        };

        // Extract arguments
        for (const [index, param] of p.node.params.entries()) {
          if (param.loc?.end.line !== param.loc?.start.line) {
            continue;
          }
          if (!t.isAssignmentPattern(param) && !t.isIdentifier(param)) {
            continue;
          }
          const lparam = (
            t.isAssignmentPattern(param) ? param.left : param
          ) as t.Identifier;
          if (!t.isIdentifier(lparam)) {
            continue;
          }
          const arg: FunctionArg = {
            name: lparam.name || "arg" + index,
            optional: lparam.optional || undefined,
          };

          // Infer from type annotations
          if (lparam.typeAnnotation) {
            Object.assign(
              arg,
              mergedTypes(
                arg,
                inferAnnotationType(lparam.typeAnnotation!, getCode)!,
              ),
            );
          }

          // Infer type from default value
          if (param.type === "AssignmentPattern") {
            Object.assign(
              arg,
              mergedTypes(arg, inferArgType(param.right, getCode)),
            );
          }
          schema.args = schema.args || [];
          schema.args.push(arg);
        }

        // Return type annotation
        if (p.node.returnType?.type === "TSTypeAnnotation") {
          schema.returns = inferAnnotationType(p.node.returnType, getCode);
        }

        // Extract and apply any manual types
        schema.tags = schema.tags?.filter((tag) => {
          if (tag.startsWith("@returns")) {
            const { type } =
              tag.match(/^@returns\s+{(?<type>[\S\s]+)}/)?.groups || {};
            if (type) {
              schema.returns = schema.returns || {};
              Object.assign(schema.returns, getTypeDescriptor(type));
              return false;
            }
          }
          if (tag.startsWith("@param")) {
            const { type, param } =
              tag.match(/^@param\s+{(?<type>[\S\s]+)}\s+(?<param>\w+)/)
                ?.groups || {};
            if (type && param) {
              const arg = schema.args?.find((arg) => arg.name === param);
              if (arg) {
                Object.assign(arg, getTypeDescriptor(type));
                return false;
              }
            }
          }
          return true;
        });

        // Replace function with it's meta
        if (p.parent.type === "ExportDefaultDeclaration") {
          p.replaceWith(astify({ $schema: schema }));
        } else {
          p.replaceWith(
            t.variableDeclaration("const", [
              t.variableDeclarator(
                t.identifier(p.node.id!.name),
                astify({ $schema: schema }),
              ),
            ]),
          );
        }
      },
    },
  };
};

export default babelPluginUntyped;

function isExampleBlock(line = "") {
  return line.startsWith("@example");
}

function containsIncompleteCodeblock(line = "") {
  const codeDelimiters = line
    .split("\n")
    .filter((line) => line.startsWith("```")).length;
  return !!(codeDelimiters % 2);
}

function clumpLines(lines: string[], delimiters = [" "], separator = " ") {
  const clumps: string[] = [];

  while (lines.length > 0) {
    const line = lines.shift() as string;

    // If there is no previous clump, create one
    if (!clumps.at(-1)) {
      clumps.push(line);
      continue;
    }

    // If the line starts with a delimiter, create a new clump
    if (delimiters.includes(line[0])) {
      clumps.push(line);
      continue;
    }

    // If the previous clump is an example block, append to it
    if (isExampleBlock(clumps.at(-1))) {
      clumps[clumps.length - 1] += separator + line;
      continue;
    }

    // If the previous clump is an incomplete code block, append to it
    if (containsIncompleteCodeblock(clumps.at(-1))) {
      clumps[clumps.length - 1] += separator + line;
      continue;
    }

    // If the line starts with a code block delimiter, create a new clump
    // We need to check this after the previous check to avoid creating a new clump for an incomplete code block
    if (line.startsWith("```")) {
      clumps.push(line);
      continue;
    }

    // Append to the previous clump
    if (line) {
      clumps[clumps.length - 1] += separator + line;
      continue;
    }

    // If the line is empty, create a new clump
    clumps.push(line);
  }

  return clumps.filter(Boolean);
}

function parseJSDocs(input: string | string[]): Schema {
  const schema: Schema = {
    title: "",
    description: "",
    tags: [],
  };

  const lines: string[] = (Array.isArray(input) ? input : [input]).flatMap(
    (c) => c.split("\n").map((l) => l.replace(/(^\s*\*+ )|([\s*]+$)/g, "")),
  );

  const firstTag = lines.findIndex((l) => l.startsWith("@"));
  const comments = clumpLines(
    lines.slice(0, firstTag === -1 ? undefined : firstTag),
  );

  if (comments.length === 1) {
    schema.title = comments[0];
  } else if (comments.length > 1) {
    schema.title = comments[0];
    schema.description = comments.splice(1).join("\n");
  }

  if (firstTag !== -1) {
    const tags = clumpLines(lines.slice(firstTag), ["@"], "\n");
    // eslint-disable-next-line unicorn/no-array-reduce
    const typedefs = tags.reduce(
      (typedefs, tag) => {
        const { typedef, alias } =
          tag.match(/@typedef\s+{(?<typedef>[\S\s]+)} (?<alias>.*)/)?.groups ||
          {};
        if (typedef && alias) {
          typedefs[typedef] = alias;
        }
        return typedefs;
      },
      {} as Record<string, string>,
    );
    for (const tag of tags) {
      if (tag.startsWith("@type")) {
        const type = tag.match(/@type\s+{([\S\s]+)}/)?.[1];
        // Skip typedefs
        if (!type) {
          continue;
        }
        Object.assign(schema, getTypeDescriptor(type));
        for (const typedef in typedefs) {
          schema.markdownType = type;
          if (schema.tsType) {
            schema.tsType = schema.tsType.replace(
              new RegExp(typedefs[typedef], "g"),
              typedef,
            );
          }
        }
        continue;
      }
      schema.tags!.push(tag.trim());
    }
  }

  return schema;
}

function astify(
  val: unknown,
): t.Literal | t.Identifier | t.ArrayExpression | t.ObjectExpression {
  if (typeof val === "string") {
    return t.stringLiteral(val);
  }
  if (typeof val === "boolean") {
    return t.booleanLiteral(val);
  }
  if (typeof val === "number") {
    return t.numericLiteral(val);
  }
  if (val === null) {
    return t.nullLiteral();
  }
  if (val === undefined) {
    return t.identifier("undefined");
  }
  if (Array.isArray(val)) {
    return t.arrayExpression(val.map((item) => astify(item)));
  }
  return t.objectExpression(
    Object.getOwnPropertyNames(val)
      .filter(
        (key) =>
          val[key as keyof typeof val] !== undefined &&
          val[key as keyof typeof val] !== null,
      )
      .map((key) =>
        t.objectProperty(
          t.identifier(key),
          astify(val[key as keyof typeof val]),
        ),
      ),
  );
}

const AST_JSTYPE_MAP: Partial<Record<t.Expression["type"], JSType | "RegExp">> =
  {
    StringLiteral: "string",
    BooleanLiteral: "boolean",
    BigIntLiteral: "bigint",
    DecimalLiteral: "number",
    NumericLiteral: "number",
    ObjectExpression: "object",
    FunctionExpression: "function",
    ArrowFunctionExpression: "function",
    RegExpLiteral: "RegExp",
  };

function inferArgType(e: t.Expression, getCode: GetCodeFn): TypeDescriptor {
  if (AST_JSTYPE_MAP[e.type]) {
    return getTypeDescriptor(AST_JSTYPE_MAP[e.type]!);
  }
  if (e.type === "AssignmentExpression") {
    return inferArgType(e.right, getCode);
  }
  if (e.type === "NewExpression" && e.callee.type === "Identifier") {
    return getTypeDescriptor(e.callee.name);
  }
  if (e.type === "ArrayExpression" || e.type === "TupleExpression") {
    const itemTypes = e.elements
      .filter((el) => t.isExpression(el))
      .flatMap((el) => inferArgType(el as any, getCode).type);
    return {
      type: "array",
      items: {
        type: normalizeTypes(itemTypes as JSType[]),
      },
    };
  }
  return {};
}

function inferAnnotationType(
  ann: t.Identifier["typeAnnotation"],
  getCode: GetCodeFn,
): TypeDescriptor | undefined {
  if (ann?.type !== "TSTypeAnnotation") {
    return undefined;
  }
  return inferTSType(ann.typeAnnotation, getCode);
}

function inferTSType(tsType: t.TSType, getCode: GetCodeFn): TypeDescriptor {
  if (tsType.type === "TSParenthesizedType") {
    return inferTSType(tsType.typeAnnotation, getCode);
  }
  if (tsType.type === "TSTypeReference") {
    if (
      tsType.typeParameters &&
      "name" in tsType.typeName &&
      tsType.typeName.name === "Array"
    ) {
      return {
        type: "array",
        items: inferTSType(tsType.typeParameters.params[0], getCode),
      };
    }
    return getTypeDescriptor(getCode(tsType.loc));
  }
  if (tsType.type === "TSUnionType") {
    return mergedTypes(...tsType.types.map((t) => inferTSType(t, getCode)));
  }
  if (tsType.type === "TSArrayType") {
    return {
      type: "array",
      items: inferTSType(tsType.elementType, getCode),
    };
  }
  // if (tsType.type.endsWith('Keyword')) {
  return getTypeDescriptor(getCode(tsType.loc));
  // }
  // return null
}
