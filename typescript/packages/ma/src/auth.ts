import { advanceSecretSlot, secretStaging, type SecretFile, type CredentialStore } from "@modular-agent/core";
import { SubscriptionLogins, type LoginContents } from "@modular-agent/subscription";
import { join } from "node:path";

export { expired, type Login, type OAuth } from "@modular-agent/subscription";
type Contents = LoginContents & SecretFile & { answers: Record<string, string> };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const ordered = (entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
function answersFile(data: LoginContents): Contents {
  const { answers = {}, staging } = data;
  if (!object(answers) || Object.values(answers).some(answer => typeof answer !== "string") ||
      (staging !== undefined && (!object(staging) || !object(staging.generations) || !object(staging.requests))))
    throw new Error("The credential file has invalid secret answers");
  return { ...data, answers: Object.assign(Object.create(null), answers) } as Contents;
}

export class AuthFile extends SubscriptionLogins {
  constructor(readonly directory: string) { super(join(directory, "auth.json")); }
  credentials(): CredentialStore {
    const read = () => this.read();
    const update = async <T>(change: (file: Contents) => Promise<T>) => {
      let result: T;
      await this.update(async data => {
        const file = answersFile(data);
        result = await change(file);
        Object.assign(data, file, { answers: ordered(file.answers) });
        return true;
      });
      return result!;
    };
    const modify: CredentialStore["modify"] = (name, change) => update(async file => {
      const value = await change(file.answers[name]);
      if (value === undefined) delete file.answers[name];
      else if (typeof value === "string") file.answers[name] = value;
      else throw new Error("Secret answers must be strings");
      advanceSecretSlot(file, name);
      return value;
    });
    return {
      ...secretStaging(read, update, (file, name, value) => { file.answers[name] = value; }),
      read: async name => (await read()).answers[name],
      list: async () => Object.keys((await read()).answers).map(providerId => ({ providerId, type: "api_key" })),
      modify, delete: async name => { await modify(name, async () => undefined); },
    };
  }
  override async read(): Promise<Contents> { return answersFile(await super.read()); }
}
