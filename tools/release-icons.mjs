#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const textExtensions = new Set([".json", ".js", ".mjs", ".cjs", ".hbs", ".html", ".css", ".svg"]);
const posix = value => value.split(path.sep).join("/");

async function listFiles(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${file}`);
    if (entry.isDirectory()) files.push(...await listFiles(file));
    else if (entry.isFile()) files.push(file);
  }
  return files.sort();
}

function decodeReference(value) {
  return value.replace(/%[\da-f]{2}(?:%[\da-f]{2})*/gi, encoded => {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  }).replaceAll("&amp;", "&").replaceAll("\\/", "/");
}

/** Scan JSON values (including embedded macros and HTML), scripts and templates. */
export async function planReleaseIcons(moduleRoot) {
  moduleRoot = path.resolve(moduleRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(moduleRoot, "module.json"), "utf8"));
  if (manifest.id !== "dnd5e_classpack") throw new Error("Expected the ClassPack module directory.");
  const files = await listFiles(moduleRoot);
  const assets = [];
  for (const file of files) {
    const relative = posix(path.relative(moduleRoot, file));
    if (!relative.startsWith("Nicons/")) continue;
    assets.push({ path: relative, bytes: (await fs.stat(file)).size });
  }
  const candidates = [...assets].sort((a, b) => b.path.length - a.path.length);
  const references = new Map(), dynamicReferences = [], missingReferences = [], caseMismatches = [];
  function inspect(value, file, pointer) {
    value = decodeReference(value);
    for (const match of value.matchAll(/(?:modules\/dnd5e_classpack\/)?nicons\//gi)) {
      const tail = value.slice(match.index + match[0].length - "Nicons/".length);
      const lowered = tail.toLowerCase();
      const asset = candidates.find(candidate => lowered.startsWith(candidate.path.toLowerCase())
        && !/[\w.\/%~-]/.test(tail[candidate.path.length] ?? ""));
      const reference = { file, pointer };
      if (asset) {
        const refs = references.get(asset.path) ?? [];
        refs.push(reference);
        references.set(asset.path, refs);
        if (!tail.startsWith(asset.path)) caseMismatches.push({ ...reference, actual: asset.path,
          referenced: tail.slice(0, asset.path.length) });
        continue;
      }
      const literal = tail.match(/^Nicons\/[^\r\n<>"'`\\]*?\.(?:png|jpe?g|webp|svg|gif|avif|webm|mp4)(?=$|[?#\s"'`<>)}\],;])/i)?.[0];
      if (literal && !/[$*?{}]/.test(literal)) missingReferences.push({ ...reference, referenced: literal });
      else {
        // Keep the entire fixed prefix when a macro constructs a filename at runtime.
        const fixed = tail.split(/[\r\n<>"'`\\$*?{}]/)[0];
        const prefix = fixed.slice(0, fixed.lastIndexOf("/") + 1) || "Nicons/";
        dynamicReferences.push({ ...reference, prefix, expression: tail.slice(0, 160) });
      }
    }
  }
  function visit(value, file, pointer = "") {
    if (typeof value === "string") inspect(value, file, pointer);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, file,
        `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
    }
  }
  for (const file of files) {
    const relative = posix(path.relative(moduleRoot, file));
    if (relative.startsWith("Nicons/") || !textExtensions.has(path.extname(file).toLowerCase())) continue;
    const source = await fs.readFile(file, "utf8");
    if (!/nicons(?:\\?\/|%2f)/i.test(source)) continue;
    if (path.extname(file).toLowerCase() === ".json") visit(JSON.parse(source), relative);
    else inspect(source, relative, "");
  }
  const keep = [], exclude = [];
  for (const asset of assets) {
    const refs = references.get(asset.path) ?? [];
    const dynamic = dynamicReferences.some(ref => asset.path.toLowerCase().startsWith(ref.prefix.toLowerCase()));
    (refs.length || dynamic ? keep : exclude).push({ ...asset, ...(refs.length ? { references: refs } : {}),
      ...(dynamic ? { dynamic: true } : {}) });
  }
  const bytes = rows => rows.reduce((total, row) => total + row.bytes, 0);
  return { schemaVersion: 1, moduleId: manifest.id, keep, exclude, dynamicReferences, missingReferences, caseMismatches,
    summary: { files: assets.length, bytes: bytes(assets), keptFiles: keep.length, keptBytes: bytes(keep),
      excludedFiles: exclude.length, excludedBytes: bytes(exclude) } };
}

/** Copy a fresh release tree. Never delete or overwrite the original assets. */
export async function stageReleaseModule(moduleRoot, stageRoot, plan, { keepAllIcons = false } = {}) {
  moduleRoot = path.resolve(moduleRoot);
  stageRoot = path.resolve(stageRoot);
  if (stageRoot === moduleRoot || stageRoot.startsWith(moduleRoot + path.sep)) {
    throw new Error("The release staging directory must be outside the module directory.");
  }
  if (plan.schemaVersion !== 1 || plan.moduleId !== "dnd5e_classpack") throw new Error("Invalid icon plan.");
  if (plan.missingReferences.length || plan.caseMismatches.length) throw new Error("Fix missing or case-sensitive icon references before packaging.");
  const keep = new Set((keepAllIcons ? [...plan.keep, ...plan.exclude] : plan.keep).map(row => {
    if (!row.path.startsWith("Nicons/") || path.posix.normalize(row.path) !== row.path || row.path.includes("\\")) {
      throw new Error(`Invalid icon path: ${row.path}`);
    }
    return row.path;
  }));
  for (const file of keep) {
    const stat = await fs.lstat(path.join(moduleRoot, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid icon asset: ${file}`);
  }
  const directories = new Set(["Nicons"]);
  for (const file of keep) {
    for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) directories.add(dir);
  }
  await fs.mkdir(path.dirname(stageRoot), { recursive: true });
  await fs.mkdir(stageRoot); // Refuse to reuse an existing release tree.
  const destination = path.join(stageRoot, plan.moduleId);
  await fs.cp(moduleRoot, destination, { recursive: true, errorOnExist: true, force: false,
    filter: async file => {
      if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${file}`);
      const relative = posix(path.relative(moduleRoot, file));
      if (relative !== "Nicons" && !relative.startsWith("Nicons/")) return true;
      return keep.has(relative) || directories.has(relative);
    } });
  return { destination, keptIcons: keep.size, excludedIcons: keepAllIcons ? 0 : plan.exclude.length };
}

async function main(args) {
  let moduleRoot = path.join(repository, "dnd5e_classpack"), planFile, stageRoot, keepAllIcons = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--module", "--plan", "--stage"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--module") moduleRoot = value;
      else if (arg === "--plan") planFile = value;
      else stageRoot = value;
    } else if (arg === "--keep-all-icons") keepAllIcons = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!planFile) throw new Error("Usage: node tools/release-icons.mjs --plan FILE [--stage DIRECTORY] [--keep-all-icons]");
  if (stageRoot) {
    const plan = JSON.parse(await fs.readFile(planFile, "utf8"));
    console.log(JSON.stringify(await stageReleaseModule(moduleRoot, stageRoot, plan, { keepAllIcons })));
  } else {
    const plan = await planReleaseIcons(moduleRoot);
    await fs.mkdir(path.dirname(path.resolve(planFile)), { recursive: true });
    await fs.writeFile(planFile, JSON.stringify(plan, null, 2) + "\n");
    console.log(JSON.stringify({ ...plan.summary, dynamicReferences: plan.dynamicReferences.length,
      missingReferences: plan.missingReferences.length, caseMismatches: plan.caseMismatches.length }));
    if (plan.missingReferences.length || plan.caseMismatches.length) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
