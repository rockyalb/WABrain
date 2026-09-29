/** Writes the OpenAPI document to packages/contracts/openapi.json for the Android client. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../openapi/document.js";

const target = fileURLToPath(new URL("../../../../packages/contracts/openapi.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`Wrote ${target}`);
