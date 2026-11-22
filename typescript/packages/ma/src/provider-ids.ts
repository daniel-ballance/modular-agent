export const formerProviderIds = { "openai-codex": "chatgpt", xai: "grok" } as const;
export const providerId = (name: string) => Object.hasOwn(formerProviderIds, name) ? formerProviderIds[name as keyof typeof formerProviderIds] : name;

export function modelRef(value: unknown): string | undefined {
  const ref = typeof value === "string" ? value : value && typeof value === "object" && "provider" in value && "id" in value ? `${value.provider}/${value.id}` : undefined;
  if (ref === undefined) return undefined;
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : providerId(ref.slice(0, slash)) + ref.slice(slash);
}
