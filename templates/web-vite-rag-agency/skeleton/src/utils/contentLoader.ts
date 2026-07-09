export interface ContentMeta {
  slug: string;
  title: string;
}

export async function loadContentIndex<T extends ContentMeta>(path: string): Promise<T[]> {
  const module = await import(path);
  return module.default ?? module;
}
