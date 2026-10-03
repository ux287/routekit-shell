export function cn(...classes) {
  return classes
    .flatMap(c => (typeof c === "string" ? c : (c && typeof c === "object" ? Object.entries(c).filter(([,v])=>!!v).map(([k])=>k) : [])))
    .filter(Boolean)
    .join(" ");
}