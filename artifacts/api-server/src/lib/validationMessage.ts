import type { ZodError } from "zod";

/** Turn a zod failure into one readable sentence for a 400 body.
 *
 *  `ZodError.message` is the JSON-stringified issue array, so returning it
 *  straight — `res.status(400).json({ error: parsed.error.message })` — puts
 *  `[{"code":"invalid_type","expected":"number","received":"string",...}]`
 *  into a toast in front of the user. It names an internal field path, leaks
 *  the shape of the API contract, and tells them nothing they can act on.
 *
 *  `labels` maps a field path to the wording the form actually uses, so the
 *  message reads "Please enter a valid Opening Balance." rather than repeating
 *  the JSON key.
 */
export function validationMessage(
  error: ZodError,
  labels: Record<string, string> = {},
): string {
  const issue = error.issues[0];
  if (!issue) return "Please check the values you entered.";

  const path = issue.path.join(".");
  const label = labels[path] ?? path;
  if (!label) return "Please check the values you entered.";

  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined"
        ? `${label} is required.`
        : `Please enter a valid ${label}.`;
    case "invalid_enum_value":
      return `${label} must be one of: ${issue.options.join(", ")}.`;
    default:
      // zod phrases the rest readably enough ("Number must be greater than or
      // equal to 0"); it only needs the field it belongs to.
      return `${label}: ${issue.message}`;
  }
}
