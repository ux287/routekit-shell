export function cn(...inputs: Array<string | Record<string, boolean> | undefined>) {
  const out: string[] = [];
  for (const i of inputs) {
    if (!i) continue;
    if (typeof i === "string") out.push(i);
    else for (const [k,v] of Object.entries(i)) v && out.push(k);
  }
  return out.join(" ");
}