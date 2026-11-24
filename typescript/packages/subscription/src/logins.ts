import { ModelFailure, withCredentialLock } from "@modular-agent/core";
import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, join } from "node:path";

export type OAuth = { type: "oauth"; access: string; refresh: string; expires: number; account?: string };
export type Login = OAuth | { type: "api_key"; key: string };
export const expired = (login: Login) => login.type === "oauth" && login.expires <= Date.now();
export type LoginContents = Record<string, unknown> & { logins: Record<string, Login> };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function loginValue(value: unknown): Login {
  if (object(value)) {
    if (value.type === "api_key" && typeof value.key === "string") return { type: "api_key", key: value.key };
    if (value.type === "oauth" && typeof value.access === "string" && typeof value.refresh === "string" &&
        typeof value.expires === "number" && Number.isSafeInteger(value.expires) && value.expires >= 0 &&
        (value.account == null || typeof value.account === "string"))
      return { type: "oauth", access: value.access, refresh: value.refresh, expires: value.expires,
        ...(value.account == null ? {} : { account: value.account }) };
  }
  throw new Error("invalid login");
}
const ordered = <T>(entries: Record<string, T>) => Object.fromEntries(Object.entries(entries).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))));

export class SubscriptionLogins {
  readonly #lockPath: string;
  readonly #directory: string;
  constructor(readonly path: string) {
    this.#directory = dirname(path);
    const extension = extname(path);
    this.#lockPath = (extension ? path.slice(0, -extension.length) : path) + ".lock";
    if (this.#lockPath === path) throw new Error("The login file cannot have the .lock extension");
  }
  async read(): Promise<LoginContents> {
    let raw;
    try {
      await using file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
        throw new Error("The credential file must be private to its owner");
      }
      raw = await file.readFile("utf8");
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { logins: Object.create(null) }; throw error; }
    try {
      const value: unknown = JSON.parse(raw);
      if (!object(value)) throw new Error();
      const { logins = {}, ...rest } = value;
      if (!object(logins)) throw new Error();
      const result: LoginContents = { logins: Object.create(null), ...rest };
      for (const [name, login] of Object.entries(logins)) result.logins[name] = loginValue(login);
      return result;
    } catch { throw new Error(`${this.path} is not a valid credential file`); }
  }
  async #write({ logins, ...rest }: LoginContents) {
    const tmp = join(this.#directory, `.auth-${randomUUID()}.tmp`);
    try {
      await using file = await open(tmp, "wx", 0o600);
      await file.chmod(0o600);
      // Keep Rust's field order, indentation, and absence of a final newline.
      await file.writeFile(JSON.stringify({ logins: ordered(logins), ...rest }, null, 2));
      await file.sync();
      await rename(tmp, this.path);
      await using dir = await open(this.#directory, "r");
      await dir.sync();
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      throw new Error("the credential file could not be written");
    }
  }
  /** Change the file under its exclusive lock. Return false to leave it untouched. */
  async update(change: (file: LoginContents) => boolean | Promise<boolean>, signal?: AbortSignal): Promise<void> {
    await withCredentialLock(this.#lockPath, async () => {
      const file = await this.read();
      if (await change(file)) await this.#write(file);
    }, signal);
  }
  async login(provider: string): Promise<Login | undefined> { return (await this.read()).logins[provider]; }
  async setLogin(provider: string, login?: Login): Promise<void> {
    await this.update(data => {
      if (login) data.logins[provider] = loginValue(login);
      else delete data.logins[provider];
      return true;
    });
  }
  async current(provider: string, refresh: (old: OAuth) => Promise<Login>, rejected?: Login, signal?: AbortSignal): Promise<Login> {
    const missing = () => new ModelFailure({ kind: "credentials", message: `Not signed in to ${provider}; sign in again.` });
    const old = await this.login(provider);
    if (!old) throw missing();
    const stale = (login: Login): login is OAuth => login.type === "oauth" && (expired(login) ||
      (rejected?.type === "oauth" && login.access === rejected.access && login.refresh === rejected.refresh && login.expires === rejected.expires));
    if (!stale(old)) return old;
    let current: Login | undefined;
    await this.update(async contents => {
      const latest = contents.logins[provider];
      if (!latest) throw missing();
      if (!stale(latest)) { current = latest; return false; }
      current = loginValue(await refresh(latest));
      contents.logins[provider] = current;
      return true;
    }, signal);
    return current!;
  }
}

export function subscriptionLogins(path: string): SubscriptionLogins {
  return new SubscriptionLogins(path);
}
