import { domainOf } from './text';

const BLOCKED_DOMAINS = [
  // Mail, messaging, calendars
  'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com',
  'mail.proton.me', 'proton.me', 'fastmail.com', 'web.whatsapp.com', 'web.telegram.org', 'messages.google.com',
  'messenger.com', 'discord.com', 'app.slack.com', 'teams.microsoft.com', 'calendar.google.com',
  // Passwords and identity
  '1password.com', 'lastpass.com', 'bitwarden.com', 'dashlane.com', 'okta.com', 'auth0.com', 'onelogin.com',
  // Money
  'paypal.com', 'venmo.com', 'wise.com', 'stripe.com', 'coinbase.com', 'binance.com', 'kraken.com',
  'robinhood.com', 'fidelity.com', 'schwab.com', 'vanguard.com', 'wealthsimple.com', 'questrade.com',
  'chase.com', 'wellsfargo.com', 'bankofamerica.com', 'citi.com', 'capitalone.com', 'americanexpress.com',
  'usbank.com', 'pnc.com', 'hsbc.com', 'barclays.co.uk', 'lloydsbank.com', 'natwest.com', 'santander.com',
  'td.com', 'tdbank.com', 'rbc.com', 'rbcroyalbank.com', 'scotiabank.com', 'bmo.com', 'cibc.com',
  'tangerine.ca', 'desjardins.com', 'interac.ca',
  // Health and government identity
  'mychart.com', 'mychart.org', 'irs.gov', 'ssa.gov', 'healthcare.gov',
];

const SENSITIVE_HOST = /(^|\.)(login|signin|sso|auth|account|accounts|id|secure|banking|onlinebanking|mybank|mychart|portal)\.|(^|[.-])(bank|creditunion)[.-]/i;
const SENSITIVE_PATH = /\/(login|log-in|signin|sign-in|signup|sign-up|register|logout|password|reset|2fa|mfa|verify|checkout|payment|payments|billing|wallet|invoice|invoices|settings\/security|account\/security)(\/|$)/i;
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[::1\])|\.(local|internal|intranet|lan|corp)$/i;

const matches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Whether a URL must never have its contents saved. */
export function isBlocked(url: string, userBlocked: string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const host = domainOf(url);
  if ([...BLOCKED_DOMAINS, ...userBlocked].some((d) => matches(host, d.trim().toLowerCase()))) return true;
  return PRIVATE_HOST.test(u.hostname) || SENSITIVE_HOST.test(host) || SENSITIVE_PATH.test(u.pathname);
}
