import type { EvalCase } from "../types.js";
import { changeCases } from "./changes.js";
import { createCases } from "./creates.js";
import { handledCases } from "./handled.js";
import { noiseCases } from "./noise.js";
import { pendingCases } from "./pending.js";

export const evalCases: EvalCase[] = [...createCases, ...changeCases, ...noiseCases, ...pendingCases, ...handledCases];
