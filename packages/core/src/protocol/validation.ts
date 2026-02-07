import { type } from "arktype";

export const integerString = type(/^(0|[1-9]\d*)$/);

export function isInteger(value: string): boolean {
  return !(integerString(value) instanceof type.errors);
}
