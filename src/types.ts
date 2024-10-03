export type JSValue =
  | string
  | number
  | bigint
  | boolean
  | symbol
  | Function // eslint-disable-line @typescript-eslint/no-unsafe-function-type
  | Array<any>
  | undefined
  | object
  | null;

export type JSType =
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "symbol"
  | "function"
  | "object"
  | "any"
  | "array";

export type ResolveFn = (
  value: unknown,
  get: (key: string) => Promise<unknown>,
) => JSValue | Promise<JSValue>;

export interface TypeDescriptor {
  /** Used internally to handle schema types */
  type?: JSType | JSType[];
  /** Fully resolved correct TypeScript type for generated TS declarations */
  tsType?: string;
  /** Human-readable type description for use in generated documentation */
  markdownType?: string;
  items?: TypeDescriptor | TypeDescriptor[];
}

export interface FunctionArg extends TypeDescriptor {
  name?: string;
  default?: JSValue;
  optional?: boolean;
}

export interface Schema extends TypeDescriptor {
  id?: string;
  default?: JSValue;
  resolve?: ResolveFn;
  properties?: { [key: string]: Schema };
  required?: string[];
  title?: string;
  description?: string;
  $schema?: string;
  tags?: string[];
  args?: FunctionArg[];
  returns?: TypeDescriptor;
}

export interface InputObject {
  $schema?: Schema;
  $resolve?: ResolveFn;
  $default?: any;
  [key: string]: JSValue | InputObject;
}

export type InputValue = InputObject | JSValue;

export type SchemaDefinition = {
  [x: string]: JSValue | InputObject;
};
