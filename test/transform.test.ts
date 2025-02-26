import { describe, it, expect } from "vitest";
import { transform as babelTransform } from "@babel/standalone";
import untypedPlugin from "../src/loader/babel";

function transform(src: string, opts = {}) {
  const res = babelTransform(src, {
    filename: "src.ts",
    presets: ["typescript"],
    plugins: [[untypedPlugin, opts]],
  });
  return res.code!;
}

describe("transform (functions)", () => {
  it("creates correct types for simple function", () => {
    const result = transform(`
      /** @untyped */
      export function add (id: string, date = new Date(), append?: boolean) {}
    `);

    expectCodeToMatch(result, /export const add = ([\S\s]*)$/, {
      $schema: {
        type: "function",
        args: [
          {
            name: "id",
            type: "string",
          },
          {
            name: "date",
            tsType: "Date",
          },
          {
            name: "append",
            optional: true,
            type: "boolean",
          },
        ],
      },
    });
  });

  it("infers correct types from defaults", () => {
    const result = transform(`
      /** @untyped */
      export function add (test = ['42', 2], append?: false) {}
    `);

    expectCodeToMatch(result, /export const add = ([\S\s]*)$/, {
      $schema: {
        type: "function",
        args: [
          {
            name: "test",
            type: "array",
            items: {
              type: ["string", "number"],
            },
          },
          {
            name: "append",
            tsType: "false",
          },
        ],
      },
    });
  });

  it("correctly uses a defined return type", () => {
    const result = transform(`
      /** @untyped */
      export function add (): void {}
    `);

    expectCodeToMatch(result, /export const add = ([\S\s]*)$/, {
      $schema: {
        type: "function",
        args: [],
        returns: {
          tsType: "void",
        },
      },
    });
  });

  it("correctly uses JSdoc return types", () => {
    const result = transform(`
      /**
       * @untyped
       * @param {number} a
       * @param {number} b
       * @returns {void}
       */
      export function add (a, b) {}
    `);

    expectCodeToMatch(result, /export const add = ([\S\s]*)$/, {
      $schema: {
        type: "function",
        args: [
          { name: "a", type: "number" },
          { name: "b", type: "number" },
        ],
        returns: {
          tsType: "void",
        },
      },
    });
  });

  it("correctly handles a function assigned to a variable", () => {
    const results = [
      transform(`
      /** @untyped */
      export const bob = function add (test: string): string {}
    `),
      transform(`
      /** @untyped */
      export const bob = (test: string): string => {}
    `),
    ];

    for (const result of results) {
      expectCodeToMatch(result, /export const bob = ([\S\s]*)$/, {
        $schema: {
          type: "function",
          args: [
            {
              name: "test",
              type: "string",
            },
          ],
          returns: {
            type: "string",
          },
        },
      });
    }
  });
});

describe("transform (jsdoc)", () => {
  it("extracts title and description from jsdoc", () => {
    const result = transform(`
      export default {
        /**
         * Define the source directory of
         * your Nuxt application.
         *
         * This property can be overwritten (for example, running \`nuxt ./my-app/\`
         * will set the \`rootDir\` to the absolute path of \`./my-app/\` from the
         * current/working directory.
         *
         * With more content in description.
         */
        srcDir: 'src'
      }
    `);
    expectCodeToMatch(result, /export default ([\S\s]*)$/, {
      srcDir: {
        $default: "src",
        $schema: {
          title: "Define the source directory of your Nuxt application.",
          description:
            "This property can be overwritten (for example, running `nuxt ./my-app/` will set the `rootDir` to the absolute path of `./my-app/` from the current/working directory.\nWith more content in description.",
          tags: [],
        },
      },
    });
  });

  it("correctly parses tags", () => {
    const result = transform(`
      export default {
        /**
         * Define the source directory of your Nuxt application.
         *
         * This property can be overwritten.
         * @note This is a note.
         * that is on two lines
         * @example
         * \`\`\`js
         * export default secretNumber = 42
         * \`\`\`
         *
         * @see https://nuxtjs.org
         */
        srcDir: 'src'
      }
    `);
    expectCodeToMatch(result, /export default ([\S\s]*)$/, {
      srcDir: {
        $default: "src",
        $schema: {
          title: "Define the source directory of your Nuxt application.",
          description: "This property can be overwritten.",
          tags: [
            "@note This is a note.\nthat is on two lines",
            "@example\n```js\nexport default secretNumber = 42\n```",
            "@see https://nuxtjs.org",
          ],
        },
      },
    });
  });

  it("correctly parses @type tags", () => {
    const result = transform(`
      export default {
        /**
         * @type {'src' | 'root'}
         */
        srcDir: 'src',
        /**
         * @type {null | typeof import('path').posix | typeof import('net')['Socket']['PassThrough']}
         */
        posix: null,
        /**
         * @type {null | {
         *   foo: 'bar' | 'baz'
         * }}
         */
        multiline: null
      }
    `);
    expectCodeToMatch(result, /export default ([\S\s]*)$/, {
      srcDir: {
        $default: "src",
        $schema: {
          title: "",
          description: "",
          tsType: "'src' | 'root'",
        },
      },
      posix: {
        $default: null,
        $schema: {
          title: "",
          description: "",
          tsType:
            "null | typeof import('path').posix | typeof import('net')['Socket']['PassThrough']",
          markdownType: "null | PathPosix | NetSocket['PassThrough']",
        },
      },
      multiline: {
        $default: null,
        $schema: {
          title: "",
          description: "",
          tsType: "null | {\n  foo: 'bar' | 'baz'\n}",
        },
      },
    });
  });

  it("correctly parses @typedef tags", () => {
    const result = transform(`
      export default {
        /**
         * @typedef {'src' | 'root'} HumanReadable
         * @type {Array<HumanReadable>}
         */
        srcDir: 'src',
      }
    `);
    expectCodeToMatch(result, /export default ([\S\s]*)$/, {
      srcDir: {
        $default: "src",
        $schema: {
          title: "",
          description: "",
          tsType: "Array<'src' | 'root'>",
          markdownType: "Array<HumanReadable>",
        },
      },
    });
  });

  it("correctly parses only tags", () => {
    const result = transform(`
      export default {
        /**
         * @note This is a note.
         * that is on two lines
         * @example
         * \`\`\`js
         * export default secretNumber = 42
         * \`\`\`
         *
         * @see https://nuxtjs.org
         */
        srcDir: 'src'
      }
    `);
    expectCodeToMatch(result, /export default ([\S\s]*)$/, {
      srcDir: {
        $default: "src",
        $schema: {
          title: "",
          description: "",
          tags: [
            "@note This is a note.\nthat is on two lines",
            "@example\n```js\nexport default secretNumber = 42\n```",
            "@see https://nuxtjs.org",
          ],
        },
      },
    });
  });

  it("does not split within a codeblock", () => {
    const result = transform(`
      export default {
        /**
         * @example
         * \`\`\`js
         * export default secretNumber = 42
         *
         * export default nothing = null
         * \`\`\`
         */
        srcDir: 'src'
      }
    `);
    expectCodeToMatch(result, /export default ([\S\s]*)$/, {
      srcDir: {
        $default: "src",
        $schema: {
          title: "",
          description: "",
          tags: [
            "@example\n```js\nexport default secretNumber = 42\n\nexport default nothing = null\n```",
          ],
        },
      },
    });
  });

  it("does not split example without codeblock", () => {
    const result = transform(`
      export default {
        /**
         * @note This is a note.
         * @example
         * export default secretNumber = 42
         *
         * export default nothing = null
         * @type {'src' | 'root'}
         */
        srcDir: 'src'
      }
    `);
    expectCodeToMatch(result, /export default ([\S\s]*)$/, {
      srcDir: {
        $default: "src",
        $schema: {
          title: "",
          tsType: "'src' | 'root'",
          description: "",
          tags: [
            "@note This is a note.",
            "@example\nexport default secretNumber = 42\n\nexport default nothing = null",
          ],
        },
      },
    });
  });

  it("supports codeblock without `@example`", () => {
    const result = transform(`
      export default {
        /**
         * @note This is a note.
         * \`\`\`js
         * export default secret
         * \`\`\`
         * @type {'src' | 'root'}
         */
        srcDir: 'src'
      }
    `);
    expectCodeToMatch(result, /export default ([\S\s]*)$/, {
      srcDir: {
        $default: "src",
        $schema: {
          title: "",
          tsType: "'src' | 'root'",
          description: "",
          tags: ["@note This is a note.", "```js\nexport default secret\n```"],
        },
      },
    });
  });

  it("correctly parses type assertion", () => {
    const result = transform(`
      import type { InputObject } from 'untyped'
      export default {
        /**
         * @typedef {'src' | 'root'} HumanReadable
         * @type {Array<HumanReadable>}
         */
        srcDir: <InputObject>{
          $resolve(val, get) {
            return val ?? 'src'
          }
        }
      }
    `);
    expect(result).toMatchInlineSnapshot(`
      "export default {
        srcDir: {
          $schema: {
            title: "",
            description: "",
            tags: [],
            tsType: "Array<'src' | 'root'>",
            markdownType: "Array<HumanReadable>"
          },
          $resolve(val, get) {
            return val ?? 'src';
          }
        }
      };"
    `);
  });

  it("correctly parses type as assertion", () => {
    const result = transform(`
      import type { InputObject } from 'untyped'
      export default {
        /**
         * @typedef {'src' | 'root'} HumanReadable
         * @type {Array<HumanReadable>}
         */
        srcDir: {
          $resolve(val, get) {
            return val ?? 'src'
          }
        } as InputObject
      }
    `);
    expect(result).toMatchInlineSnapshot(`
      "export default {
        srcDir: {
          $schema: {
            title: "",
            description: "",
            tags: [],
            tsType: "Array<'src' | 'root'>",
            markdownType: "Array<HumanReadable>"
          },
          $resolve(val, get) {
            return val ?? 'src';
          }
        }
      };"
    `);
  });

  it("support define function", () => {
    const result = transform(`
      export default defineUntypedSchema({
        /**
         * @type {'src' | 'root'}
         */
        srcDir: 'src',
        multiline: {
          $resolve(val) {
            return val || false
          }
        }
      })
    `);
    expect(result).toMatchInlineSnapshot(`
      "export default defineUntypedSchema({
        srcDir: {
          $default: 'src',
          $schema: {
            title: "",
            description: "",
            tags: [],
            tsType: "'src' | 'root'"
          }
        },
        multiline: {
          $resolve(val) {
            return val || false;
          }
        }
      });"
    `);
  });
});

function expectCodeToMatch(code: string, pattern: RegExp, expected: any) {
  const [, result] = code.match(pattern) || [];
  expect(result).toBeDefined();
  // eslint-disable-next-line unicorn/new-for-builtins
  const obj = Function(
    '"use strict";return (' + result.replace(/;$/, "") + ")",
  )();
  expect(obj).toMatchObject(expected);
}
