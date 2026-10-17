/**
 * Shared helpers for the classpack tooling: CJK-preserving naming and the
 * Foundry VTT CLI API loader. Used by both `repackage.mjs` (JSON -> JSON
 * re-extraction) and `pull-from-foundry.mjs` (Foundry ldb -> JSON).
 *
 * The naming rules here are the single source of truth for file/directory
 * names, so that every script produces the same "中文名称_<id>.json" layout and
 * git diffs stay clean.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the module's packs directory (the JSON source of truth). */
export const PACKS_ROOT = path.resolve(__dirname, "..", "..", "dnd5e_classpack", "packs");

/**
 * Filesystem-safe but CJK-preserving name sanitizer. Unlike the CLI's
 * `getSafeFilename()` (which keeps only [a-zA-Z0-9] + Cyrillic), this only
 * removes characters that are illegal in file/directory names, so Chinese text
 * is preserved.
 * @param {*} name
 * @returns {string}
 */
export function safeName(name) {
  if ( name == null ) return "";
  return String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") // illegal + control chars
    .replace(/^\.+/, "")                          // leading dots
    .replace(/[. ]+$/, "")                        // trailing dots/spaces (Windows)
    .trim() || "_";
}

/**
 * Filename for a regular document: "<名称>_<id>.json". Folder documents return
 * `undefined` so the CLI's default `_Folder.json` logic runs (placing the file
 * inside the directory named by `transformFolderName`).
 * @param {object} doc
 * @param {{documentType?: string, folder?: string}} [context]
 * @returns {string|undefined}
 */
export function transformName(doc, { folder } = {}) {
  if ( doc._key?.startsWith("!folders!") ) return undefined;
  const base = doc.name ? `${safeName(doc.name)}_${doc._id}` : doc._id;
  const filename = `${base}.json`;
  return folder ? path.join(folder, filename) : filename;
}

/**
 * Directory name for a Folder document.
 * @param {object} doc
 * @returns {string}
 */
export function transformFolderName(doc) {
  return doc.name ? `${safeName(doc.name)}_${doc._id}` : doc._id;
}

/**
 * Resolve the npm global root (where `@foundryvtt/foundryvtt-cli` is installed)
 * without using `shell: true` (which triggers a Node deprecation warning).
 * @returns {string}
 */
function getNpmGlobalRoot() {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "cmd.exe" : "npm";
  const args = isWin ? ["/c", "npm root -g"] : ["root", "-g"];
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if ( res.status !== 0 ) return "";
  return res.stdout.trim();
}

/**
 * Load the Foundry VTT CLI's API (`compilePack`, `extractPack`) from the global
 * installation.
 * @returns {Promise<{compilePack: Function, extractPack: Function}>}
 */
export async function loadCliApi() {
  const globalRoot = getNpmGlobalRoot();
  const cliEntry = path.join(globalRoot, "@foundryvtt", "foundryvtt-cli", "index.mjs");
  if ( !globalRoot || !fs.existsSync(cliEntry) ) {
    console.error(`Foundry VTT CLI not found at ${cliEntry || "<global node_modules>"}.`);
    console.error("Install it with: npm install -g @foundryvtt/foundryvtt-cli");
    process.exit(1);
  }
  return import(pathToFileURL(cliEntry).href);
}

/**
 * Recursively remove `*.json` under `root`, pruning any directories left empty.
 * Non-JSON files (e.g. token images) are preserved, and `root` itself is never
 * removed.
 * @param {string} root
 */
export async function removeJson(root) {
  const walk = async dir => {
    for ( const e of await fsp.readdir(dir, { withFileTypes: true }) ) {
      const p = path.join(dir, e.name);
      if ( e.isDirectory() ) await walk(p);
      else if ( e.name.endsWith(".json") ) await fsp.rm(p, { force: true });
    }
    const remaining = await fsp.readdir(dir);
    if ( remaining.length === 0 && dir !== root ) await fsp.rmdir(dir);
  };
  await walk(root);
}

/**
 * Recursively copy a directory tree.
 * @param {string} src
 * @param {string} dst
 */
export async function copyTree(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  for ( const e of await fsp.readdir(src, { withFileTypes: true }) ) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if ( e.isDirectory() ) await copyTree(s, d);
    else await fsp.copyFile(s, d);
  }
}

/**
 * List pack directory names under `PACKS_ROOT`, sorted.
 * @returns {Promise<string[]>}
 */
export async function listPackNames() {
  const entries = await fsp.readdir(PACKS_ROOT, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
}

/**
 * Whether a file is locked by another process (used to detect a running
 * Foundry VTT instance holding the pack's LOCK file).
 * @param {string} filepath
 * @returns {boolean}
 */
export function isFileLocked(filepath) {
  try {
    const fd = fs.openSync(filepath, "w");
    fs.closeSync(fd);
    return false;
  } catch ( err ) {
    if ( err.code === "EBUSY" ) return true;
    if ( err.code === "ENOENT" ) return false;
    throw err;
  }
}

/**
 * Collect every document's `_stats` block from an existing JSON tree, scoped
 * per top-level document to avoid `_id` collisions across files.
 *
 * A flat `Map<_id, _stats>` is unsafe: embedded documents (e.g. a shared effect
 * in dnd5e 5.x) reuse the same `_id` in multiple compendium entries, with
 * different `_stats`. So the result is two-level:
 *
 *   Map<topLevelId, Map<embeddedId, _stats>>
 *
 * where `embeddedId` keys both the top-level document itself and every nested
 * object that carries its own `_stats` (effects, activities, etc.). Objects
 * that only hold a lightweight `_id` reference (an activity's `effects` entry)
 * have no `_stats` and are intentionally skipped.
 *
 * @param {string} root  Directory tree of JSON files.
 * @returns {Promise<Map<string, Map<string, object|undefined>>>}
 */
export async function collectStatsById(root) {
  const byTop = new Map();
  if ( !fs.existsSync(root) ) return byTop;
  const walk = async dir => {
    for ( const e of await fsp.readdir(dir, { withFileTypes: true }) ) {
      const p = path.join(dir, e.name);
      if ( e.isDirectory() ) await walk(p);
      else if ( e.name.endsWith(".json") ) {
        const data = JSON.parse(await fsp.readFile(p, "utf8"));
        const nested = new Map();
        collectStatsDeep(data, nested);
        byTop.set(data._id, nested);
      }
    }
  };
  await walk(root);
  return byTop;
}

/**
 * Recursively walk a single parsed top-level document and record `_id -> _stats`
 * for itself and every nested object that carries its own `_stats`.
 * @param {*} node  Any JSON value.
 * @param {Map<string, object|undefined>} map  Nested map for one top-level document.
 */
function collectStatsDeep(node, map) {
  if ( Array.isArray(node) ) {
    for ( const item of node ) collectStatsDeep(item, map);
    return;
  }
  if ( node && typeof node === "object" ) {
    if ( node._id != null && node._stats !== undefined ) map.set(node._id, node._stats);
    for ( const [key, value] of Object.entries(node) ) {
      if ( key === "_stats" ) continue;
      if ( value && typeof value === "object" ) collectStatsDeep(value, map);
    }
  }
}

/**
 * Restore `_stats` for each document, scoped per top-level document so shared
 * embedded `_id`s in other files never leak in. For every JSON file the
 * top-level `_id` selects its own nested map, then `_stats` is restored for
 * itself and every embedded object carrying a `_stats` whose `_id` is known.
 *
 * @param {string} root                       Directory tree of freshly extracted JSON.
 * @param {Map<string, Map<string, object|undefined>>} statsByTop  Existing `_stats`.
 */
export async function applyStats(root, statsByTop) {
  const walk = async dir => {
    for ( const e of await fsp.readdir(dir, { withFileTypes: true }) ) {
      const p = path.join(dir, e.name);
      if ( e.isDirectory() ) await walk(p);
      else if ( e.name.endsWith(".json") ) {
        const data = JSON.parse(await fsp.readFile(p, "utf8"));
        const nested = statsByTop.get(data._id);
        if ( nested && applyStatsDeep(data, nested) ) {
          await fsp.writeFile(p, JSON.stringify(data, null, 2) + "\n");
        }
      }
    }
  };
  await walk(root);
}

/**
 * Recursively restore `_stats` within one top-level document using its nested
 * map. Returns true if any `_stats` value actually changed.
 * @param {*} node  Any JSON value.
 * @param {Map<string, object|undefined>} nested  Nested map for this document.
 * @returns {boolean}
 */
function applyStatsDeep(node, nested) {
  let changed = false;
  if ( Array.isArray(node) ) {
    for ( const item of node ) changed = applyStatsDeep(item, nested) || changed;
    return changed;
  }
  if ( node && typeof node === "object" ) {
    if ( node._id != null && node._stats !== undefined && nested.has(node._id) ) {
      const before = JSON.stringify(node._stats);
      node._stats = nested.get(node._id);
      if ( before !== JSON.stringify(node._stats) ) changed = true;
    }
    for ( const [key, value] of Object.entries(node) ) {
      if ( key === "_stats" ) continue;
      if ( value && typeof value === "object" ) changed = applyStatsDeep(value, nested) || changed;
    }
  }
  return changed;
}
