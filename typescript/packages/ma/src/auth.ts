import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export type OAuth = { type: "oauth"; access: string; refresh: string; expires: number; account?: string };
export type Login = OAuth | { type: "api_key"; key: string };
export const expired = (login: Login) => login.type === "oauth" && login.expires <= Date.now();
type Contents = { logins: Record<string, Login>; answers: Record<string, string> };
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

export class AuthFile {
  readonly path: string;
  constructor(readonly directory: string) { this.path = join(directory, "auth.json"); }
  async #read(): Promise<Contents> {
    let raw;
    try { raw = await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { logins: Object.create(null), answers: Object.create(null) }; throw error; }
    try {
      const value: unknown = JSON.parse(raw);
      if (!object(value)) throw new Error();
      const { logins = {}, answers = {} } = value;
      if (!object(logins) || !object(answers)) throw new Error();
      const result: Contents = { logins: Object.create(null), answers: Object.create(null) };
      for (const [name, login] of Object.entries(logins)) result.logins[name] = loginValue(login);
      for (const [name, answer] of Object.entries(answers)) {
        if (typeof answer !== "string") throw new Error();
        result.answers[name] = answer;
      }
      return result;
    } catch { throw new Error(`${this.path} is not a valid credential file`); }
  }
  async #write({ logins, answers }: Contents) {
    const tmp = join(this.directory, `.auth-${randomUUID()}.tmp`);
    try {
      await using file = await open(tmp, "wx", 0o600);
      await file.chmod(0o600);
      // Keep Rust's field order, indentation, and absence of a final newline.
      await file.writeFile(JSON.stringify({ logins: ordered(logins), answers: ordered(answers) }, null, 2));
      await file.sync();
      await rename(tmp, this.path);
      await using dir = await open(this.directory, "r");
      await dir.sync();
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      throw new Error("the credential file could not be written");
    }
  }
  async #locked<T>(fn: () => Promise<T>, signal?: AbortSignal) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await using file = await open(join(this.directory, "auth.lock"), "a", 0o600);
    // flock(2) attaches to the open file description shared by the child and
    // this process, not its PID. The lock stays until the parent closes it.
    await new Promise<void>((resolve, reject) => {
      const lock = spawn("flock", ["-x", "3"], { stdio: ["ignore", "ignore", "ignore", file.fd], signal });
      lock.once("error", e => reject(new Error(`could not lock auth.lock: ${e.message}`)));
      lock.once("exit", code => code === 0 ? resolve() : reject(new Error("could not lock auth.lock")));
    });
    signal?.throwIfAborted();
    return await fn();
  }
  async login(provider: string) { return (await this.#read()).logins[provider]; }
  async setLogin(provider: string, login?: Login) {
    await this.#locked(async () => {
      const data = await this.#read();
      if (login) data.logins[provider] = loginValue(login);
      else delete data.logins[provider];
      await this.#write(data);
    });
  }
  async current(provider: string, refresh: (old: OAuth) => Promise<Login>, rejected?: Login, signal?: AbortSignal): Promise<Login> {
    const missing = () => new Error(`not signed in to ${provider}; run \`ma login ${provider}\``);
    const old = await this.login(provider);
    if (!old) throw missing();
    const stale = (login: Login): login is OAuth => login.type === "oauth" && (expired(login) ||
      (rejected?.type === "oauth" && login.access === rejected.access && login.refresh === rejected.refresh && login.expires === rejected.expires));
    if (!stale(old)) return old;
    return this.#locked(async () => {
      const contents = await this.#read(), latest = contents.logins[provider];
      if (!latest) throw missing();
      if (!stale(latest)) return latest;
      const fresh = loginValue(await refresh(latest));
      contents.logins[provider] = fresh;
      await this.#write(contents);
      return fresh;
    }, signal);
  }
}
