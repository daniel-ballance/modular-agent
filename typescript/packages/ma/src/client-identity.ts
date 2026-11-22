const DEFAULT_CLIENT_IDENTITY = "modular-agent";

export type ClientIdentityOptions = { clientIdentity?: string };

export function resolveClientIdentity(value: string | undefined, name = "clientIdentity"): string {
  if (value === undefined) return DEFAULT_CLIENT_IDENTITY;
  if (value.length < 1 || value.length > 64 || /[^A-Za-z0-9._-]/.test(value))
    throw new Error(`${name} must be 1 to 64 characters from A-Z, a-z, 0-9, ., _ and -`);
  return value;
}
