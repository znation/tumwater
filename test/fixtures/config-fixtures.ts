/** The config-validation test helper shared by test/config.test.ts and
 * test/config-validation.test.ts: run `validateConfig` and return its rejection message, or
 * throw when it accepts the input. Topic-named like the other fixture modules; imports only
 * the production validator and the shared error renderer. */
import { validateConfig } from "../../src/config/config-validation.js";
import { errorMessage } from "../../src/text/text.js";

export function validationError(raw: unknown): string {
  try {
    validateConfig(raw);
  } catch (err) {
    return errorMessage(err);
  }
  throw new Error("validateConfig did not throw");
}
