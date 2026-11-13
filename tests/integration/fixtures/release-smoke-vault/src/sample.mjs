// Sample source file for release-smoke fixture. The embed pipeline should
// classify any .mjs/.js/.ts file under src/ as content_type='code'. This file
// exists solely to give the smoke index a non-empty code bucket.

export function add(a, b) {
  return a + b;
}

export function describe() {
  return "release-smoke-vault sample module";
}
