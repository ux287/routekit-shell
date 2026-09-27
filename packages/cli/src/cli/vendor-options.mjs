export function normalizeVendorMode(raw) {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return "subtree";
  const value = String(raw).trim().toLowerCase();
  if (!value) return "subtree";
  if (value === "subtree" || value === "copy") return value;
  throw new Error(`Invalid --vendor value: ${raw} (expected 'subtree' or 'copy')`);
}

export function parseVendorOptions(kv = {}) {
  const mode = normalizeVendorMode(kv.vendor);
  const vendorRef = typeof kv["vendor-ref"] === "string" && kv["vendor-ref"].trim() ? kv["vendor-ref"].trim() : "main";
  const vendorRemote =
    typeof kv["vendor-remote"] === "string" && kv["vendor-remote"].trim() ? kv["vendor-remote"].trim() : null;
  const gitInit = Boolean(kv["git-init"]);
  const yes = Boolean(kv.yes);
  return { mode, vendorRef, vendorRemote, gitInit, yes };
}

