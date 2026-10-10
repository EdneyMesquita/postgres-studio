/**
 * A connect failure in two words, for the tree row; the full message goes
 * in its tooltip.
 */
export function connectErrorLabel(message: string): string {
  if (/no password is saved|saved password .* is missing|asks for a password/i.test(message)) return "Needs password";
  if (/auth|credential|password|scram|unauthori[sz]ed|not authorized/i.test(message)) {
    return "Auth failed";
  }
  if (/time[sd]?[\s_-]?out|server selection|deadline/i.test(message)) return "Timed out";
  return "Failed";
}
