import type { Context } from "hono";
import type { z } from "zod";
import { HttpError } from "./errors.js";

/** Parses a JSON body strictly: application/json only, validated by `schema`. */
export async function jsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const type = c.req.header("content-type") ?? "";
  const text = await c.req.text();
  if (!text.trim()) return schema.parse({});
  if (!/^application\/json\b/i.test(type)) throw new HttpError("validation_failed", "Content-Type must be application/json");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError("validation_failed", "Malformed JSON body");
  }
  return schema.parse(value);
}

export function queryParams<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  return schema.parse(c.req.query());
}
