// Browser lifecycle/network failures do not establish that an account is invalid.
export function isTransientVerificationError(error) {
  return /Complete sign-in in the desktop Arena page|Open Arena in the desktop workspace first|Target page, context or browser has been closed|Target closed|Execution context was destroyed|frame was detached|net::ERR_|Timeout \d+ms|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(String(error?.message || error || ''));
}
