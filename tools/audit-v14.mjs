#!/usr/bin/env node
/** Read-only source audit. Reports are the only files this tool writes. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { atPointer, parseJsonSource, sourceLocation, codeTokens, member } from "./lib/audit-source.mjs";

export const RULES = {
  "legacy-ae-changes": "ERROR", "numeric-ae-mode": "ERROR",
  "measured-template-api": "ERROR", "canvas-templates-api": "ERROR",
  "aura-collision-types": "ERROR", "aura-opacity": "ERROR",
  "finite-transfer-duration": "ERROR", "dangling-activity-effect-ref": "ERROR",
  "dangling-activity-ref": "ERROR", "duplicate-id": "ERROR", "duplicate-json-key": "ERROR",
  "midi-flags": "REVIEW", "dae-flags": "REVIEW", "dae-special-duration": "REVIEW",
  "macro-execute": "REVIEW", "midi-overtime": "REVIEW", "movement-all": "REVIEW",
  "midi-roll-advantage": "REVIEW", "damage-only-workflow": "REVIEW",
  "midi-move-token": "REVIEW", "source-dependent-formula": "REVIEW",
  "legacy-attack-bonus": "REVIEW", "local-uuid-ref": "REVIEW",
  "external-activity-ref": "REVIEW", "cpr-mapping-ref": "REVIEW",
  "activity-identifier-ref": "REVIEW", "audit-input-error": "ERROR"
};
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => value != null && Object.hasOwn(value, key);
const present = value => value !== null && value !== undefined && value !== "" && value !== "none";
const slash = value => value.split(path.sep).join("/");
const within = (parent, child) => { const rel = path.relative(parent, child); return !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel); };
const finite = value => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value)) && Number(value) >= 0;
const collectionEntries = value => Array.isArray(value) ? value.map((child, index) => [String(index), child]) : object(value) ? Object.entries(value) : [];

async function filesUnder(directory, extension) {
  const result = [];
  async function visit(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const filename = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link is not an audit input: ${filename}`);
      if (entry.isDirectory()) await visit(filename);
      else if (extension.test(entry.name)) result.push(filename);
    }
  }
  await visit(directory); return result;
}

export async function auditRepository(root) {
  root = path.resolve(root);
  const findings = [], seen = new Set(), inputs = new Map(), records = [], packs = new Map();
  let failed = false, manifest;
  const totals = { packJsonFiles: 0, folders: 0, packDocuments: 0, items: 0, actors: 0, macros: 0, journals: 0,
    embeddedItems: 0, effects: 0, activities: 0, cprIdentifiers: 0, cprMappingEntries: 0, scripts: 0 };
  function add(rule, record, pointer, message, context = {}, extra = {}) {
    const location = record.parsed?.locations.get(pointer) ?? { line: 1, column: 1 };
    const finding = { severity: RULES[rule], rule, path: record.path, jsonPointer: pointer, line: location.line,
      column: location.column, ...context, message, ...extra };
    const key = JSON.stringify([rule, record.path, pointer, extra.codeOffset ?? extra.line ?? "", message]);
    if (!seen.has(key)) { seen.add(key); findings.push(finding); }
  }
  async function read(filename, json = true) {
    const record = { path: slash(path.relative(root, filename)), filename };
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Input must be a regular file");
      record.text = await fs.readFile(filename, "utf8");
      inputs.set(record.path, createHash("sha256").update(record.text).digest("hex"));
      if (json) record.parsed = parseJsonSource(record.text);
      for (const duplicate of record.parsed?.duplicates ?? []) add("duplicate-json-key", record, duplicate.pointer,
        `Duplicate JSON property ${duplicate.key}`, {}, { line: duplicate.line, column: duplicate.column });
      return record;
    } catch (error) { failed = true; add("audit-input-error", record, "", error.message); return null; }
  }
  const moduleDir = path.join(root, "dnd5e_classpack");
  try {
    // Resolve directories as well as files so a symlink cannot move the scan outside the checkout.
    if (!within(await fs.realpath(root), await fs.realpath(moduleDir))) throw new Error("Module directory escapes repository");
    const manifestRecord = await read(path.join(moduleDir, "module.json"));
    manifest = manifestRecord?.parsed.data;
    if (!object(manifest) || !manifest.id || !Array.isArray(manifest.packs) || !manifest.packs.length) throw new Error("module.json needs id and a non-empty packs array");
    for (const pack of manifest.packs) {
      if (!pack.name || !pack.type || !pack.path || packs.has(pack.name)) throw new Error("Invalid or duplicate pack declaration");
      const directory = path.resolve(moduleDir, pack.path);
      const packsDir = path.join(moduleDir, "packs");
      if (!within(packsDir, directory) || directory === packsDir || !within(await fs.realpath(packsDir), await fs.realpath(directory))) throw new Error(`Pack path escapes packs: ${pack.path}`);
      const files = await filesUnder(directory, /\.json$/i);
      if (!files.length) throw new Error(`No JSON source in declared pack ${pack.name}`);
      const indexed = { ...pack, documents: new Map(), folders: new Set() }; packs.set(pack.name, indexed);
      for (const filename of files) {
        totals.packJsonFiles++;
        const record = await read(filename); if (!record) continue;
        const data = record.parsed.data;
        if (!object(data)) { failed = true; add("audit-input-error", record, "", "Pack source must be a document object"); continue; }
        record.kind = path.basename(filename) === "_Folder.json" || data.documentName === "Folder" || data._key?.startsWith("!folders!") ? "Folder" : pack.type;
        record.pack = pack.name; record.anchors = new Map(); records.push(record);
        if (record.kind === "Folder") {
          totals.folders++;
          if (data._id && indexed.folders.has(data._id)) add("duplicate-id", record, "/_id", "Duplicate Folder _id in pack", { documentId: data._id });
          indexed.folders.add(data._id); continue;
        }
        totals.packDocuments++;
        if (!data._id) { failed = true; add("audit-input-error", record, "", "Pack document is missing _id"); continue; }
        if (indexed.documents.has(data._id)) add("duplicate-id", record, "/_id", "Duplicate document _id in pack", { documentId: data._id });
        else indexed.documents.set(data._id, record);
      }
    }

    function uuidResult(uuid, item = null) {
      if (typeof uuid !== "string") return "invalid";
      if (uuid.startsWith(".")) {
        if (!item) return "external";
        const parts = uuid.slice(1).split(".");
        if (parts.length !== 2) return "external";
        const children = parts[0] === "ActiveEffect" ? item.effects : parts[0] === "Activity" ? item.system?.activities : null;
        return collectionEntries(children).some(([key, child]) => (child?._id ?? key) === parts[1]) ? "ok" : "missing";
      }
      const parts = uuid.split(".");
      if (parts[0] !== "Compendium" || parts[1] !== manifest.id) return "external";
      const pack = packs.get(parts[2]); if (!pack) return "missing";
      let index = 3;
      if (parts[index] === pack.type) index++;
      const record = pack.documents.get(parts[index++]); if (!record) return "missing";
      let current = record.parsed.data;
      while (index < parts.length) {
        const kind = parts[index++], id = parts[index++];
        const key = { Item: "items", ActiveEffect: "effects", JournalEntryPage: "pages", TableResult: "results", PlaylistSound: "sounds" }[kind];
        const children = kind === "Activity" ? current.system?.activities : current[key];
        if (!key && kind !== "Activity") return "invalid";
        current = collectionEntries(children).find(([key, child]) => (child?._id ?? key) === id)?.[1];
        if (!current) return "missing";
      }
      return "ok";
    }
    function script(record, code, pointer = "", context = {}) {
      const tokens = codeTokens(code), locate = sourceLocation(code);
      function issue(rule, token, message) {
        const spot = locate(token.offset);
        add(rule, record, pointer, message, context, { ...(pointer ? { codeLine: spot.line, codeColumn: spot.column, codeOffset: token.offset }
          : { line: spot.line, column: spot.column, codeOffset: token.offset }), ...(rule === "source-dependent-formula" ? { formulaContext: "UNKNOWN" } : {}) });
      }
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === "identifier") {
          const measuredTemplate = member(tokens, index, "MeasuredTemplate");
          if (token.value === "MeasuredTemplate" || measuredTemplate) {
            const candidate = measuredTemplate ?? token;
            const position = measuredTemplate ? tokens.indexOf(candidate, index + 1) : index;
            const propertyKey = tokens[position + 1]?.value === ":"
              && ["{", ","].includes(tokens[position - 1]?.value);
            const flagPath = tokens.slice(Math.max(0, position - 8), position + 1).map(part => part.value).join("");
            // V14 template Regions retain this core flag; it is not a document API.
            const coreFlag = /flags(?:\.|\?\.)core(?:\.|\?\.)MeasuredTemplate$/.test(flagPath)
              || /flags\[core\]\[MeasuredTemplate$/.test(flagPath);
            if (!propertyKey && !coreFlag) issue("measured-template-api", candidate, "Legacy MeasuredTemplate API");
          }
          if (token.value === "canvas" && member(tokens, index, "templates")) issue("canvas-templates-api", token, "Legacy canvas.templates API");
          if (token.value === "MidiQOL" && member(tokens, index, "DamageOnlyWorkflow")) issue("damage-only-workflow", token, "Midi damage-only workflow requires runtime review");
          if (token.value === "MidiQOL" && member(tokens, index, "moveToken")) issue("midi-move-token", token, "Midi moveToken requires movement review");
          if (token.value.toLowerCase() === "macro" && member(tokens, index, "execute")) issue("macro-execute", token, "Macro execution depends on runtime context");
          if (token.value === "flags") {
            const tail = tokens.slice(index, index + 10).map(part => part.value).join("");
            if (member(tokens, index, "midi-qol")) issue("midi-flags", token, "Script reads midi flags");
            if (member(tokens, index, "dae")) issue("dae-flags", token, "Script reads DAE flags");
            if (/midi-qol.*(?:advantage|disadvantage)/.test(tail)) issue("midi-roll-advantage", token, "Script depends on midi roll modes");
            if (/midi-qol.*OverTime/.test(tail)) issue("midi-overtime", token, "Script depends on midi OverTime");
          }
        }
        if (token.kind !== "regex") reviewText(record, token.value, pointer, context, token.kind === "string" ? "string" : "code", token, issue);
      }
    }
    function reviewText(record, text, pointer, context, key = "", token = null, issue = null) {
      const rules = [];
      if (/flags(?:\.|\[).*midi-qol|^flags\.midi-qol/.test(text)) rules.push("midi-flags");
      if (/flags(?:\.|\[).*dae|^flags\.dae/.test(text)) rules.push("dae-flags");
      if (/macro\.execute/i.test(text)) rules.push("macro-execute");
      if (/OverTime/i.test(text) && (/midi|flags/.test(text) || /midi-qol/.test(pointer))) rules.push("midi-overtime");
      if (/system\.attributes\.movement\.all/.test(text)) rules.push("movement-all");
      if (/flags\.midi-qol\.(?:advantage|disadvantage)/.test(text)) rules.push("midi-roll-advantage");
      if (/system\.bonuses\.All-Attacks/.test(text)) rules.push("legacy-attack-bonus");
      // Descriptions may quote formulas. Only evaluate candidates in values/formulas/code, never classify their actor.
      if (!/description|\/text\/content/.test(pointer) && /@(?:abilities\.|attributes\.|scale\.|prof\b)/.test(text)) rules.push("source-dependent-formula");
      for (const rule of rules) {
        const message = rule === "source-dependent-formula" ? "Formula context UNKNOWN; verify source actor, target actor or item/activity" : `Review dependency ${rule}: ${text.slice(0, 180)}`;
        if (issue) issue(rule, token, message); else add(rule, record, pointer, message, context, rule === "source-dependent-formula" ? { formulaContext: "UNKNOWN" } : {});
      }
      if (issue) return;
      const expression = new RegExp(`Compendium\\.${manifest.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[A-Za-z0-9_.-]+`, "g");
      for (const match of text.matchAll(expression)) {
        const uuid = match[0].replace(/\.$/, "");
        if (uuidResult(uuid) !== "ok") add("local-uuid-ref", record, pointer, `Unresolved local UUID ${uuid}`, context);
      }
    }
    function reference(record, item, value, pointer, rule, context, allowIdentifier = false, allowUuid = false) {
      if (!present(value)) return;
      const children = rule === "dangling-activity-effect-ref" ? item.effects : item.system?.activities;
      if (collectionEntries(children).some(([key, child]) => (child?._id ?? key) === value)) return;
      if (allowIdentifier) {
        if (collectionEntries(children).some(([, child]) => child?.midiProperties?.identifier === value)) return;
        // The Core slugifier does not transliterate ordinary ASCII letters or Chinese.
        if (collectionEntries(children).some(([, child]) => typeof child?.name === "string"
          && /^[A-Za-z0-9\s\u3400-\u9fff_-]+$/.test(child.name)
          && child.name.trim().toLowerCase().replace(/[\s-]+/g, "-") === value)) return;
        // midi falls back to localized activity-name.slugify(); a static scan cannot determine the localized name.
        if (!/^[A-Za-z0-9]{16}$/.test(value) && !/^(?:Compendium\.|Actor\.|Item\.|\.)/.test(value)) {
          add("activity-identifier-ref", record, pointer, `Unresolved activity identifier ${value}; verify localized name.slugify()`, context); return;
        }
      }
      if (allowUuid && (/^(?:Compendium\.|Actor\.|Item\.|\.)/.test(value))) {
        const result = uuidResult(value, item);
        const expectedKind = rule === "dangling-activity-effect-ref" ? "ActiveEffect" : "Activity";
        if (result === "ok" && new RegExp(`(?:^|\\.)${expectedKind}\\.[^.]+$`).test(value)) return;
        if (result === "external") { add("external-activity-ref", record, pointer, `External UUID cannot be resolved offline: ${value}`, context); return; }
      }
      add(rule, record, pointer, `Reference does not resolve: ${value}`, context);
    }
    function document(record, data, kind, pointer = "", inherited = {}) {
      const context = { ...inherited, documentId: data._id, documentName: data.name };
      if (kind === "ActiveEffect") { context.documentId = inherited.documentId ?? data._id; context.effectId = data._id; }
      if (kind === "Activity") { context.documentId = inherited.documentId; context.activityId = data._id ?? inherited.activityId; }
      record.anchors.set(pointer, context);
      if (kind === "Item") { totals.items++; if (pointer) totals.embeddedItems++; }
      if (kind === "Actor") totals.actors++;
      if (kind === "Macro") totals.macros++;
      if (kind === "JournalEntry") totals.journals++;
      if (kind === "Activity") totals.activities++;
      if (kind === "ActiveEffect") {
        totals.effects++;
        if (own(data, "changes")) add("legacy-ae-changes", record, atPointer(pointer, "changes"), "ActiveEffect has top-level changes", context);
        for (const base of [atPointer(pointer, "changes"), `${pointer}/system/changes`]) {
          const changes = base.endsWith("/system/changes") ? data.system?.changes : data.changes;
          collectionEntries(changes).forEach(([key, change]) => {
            if (typeof change?.mode === "number") add("numeric-ae-mode", record, `${atPointer(base, key)}/mode`, "ActiveEffect change uses numeric mode", context);
          });
        }
        if (data.type === "auraeffects.aura") for (const [key, rule] of [["collisionTypes", "aura-collision-types"], ["opacity", "aura-opacity"]]) {
          if (own(data.system, key)) add(rule, record, `${pointer}/system/${key}`, `Aura uses legacy ${key}`, context);
        }
        if (data.transfer === true && ["value", "seconds", "rounds", "turns"].some(key => finite(data.duration?.[key])))
          add("finite-transfer-duration", record, `${pointer}/duration`, "Transfer effect has finite duration", context);
      }
      function children(value, key, childKind) {
        if (value != null && !Array.isArray(value) && !object(value)) {
          failed = true; add("audit-input-error", record, `${pointer}/${key}`, "Owned collection must be an array or object", context); return;
        }
        const ids = new Set();
        for (const [index, child] of collectionEntries(value)) {
          if (!object(child)) { failed = true; add("audit-input-error", record, atPointer(`${pointer}/${key}`, index), "Owned document must be an object", context); continue; }
          const childPointer = atPointer(`${pointer}/${key}`, index), id = child._id ?? (childKind === "Activity" ? index : null);
          if (id && ids.has(id)) add("duplicate-id", record, `${childPointer}/_id`, `Duplicate ${childKind} _id within owner`, context);
          ids.add(id);
          if (childKind === "Activity" && child._id && !Array.isArray(value) && child._id !== index) add("dangling-activity-ref", record, `${childPointer}/_id`, "Activity dictionary key does not match _id", context);
          document(record, child, childKind, childPointer, { ...context, rootDocumentId: inherited.rootDocumentId ?? data._id,
            ...(childKind === "Activity" ? { activityId: id } : {}) });
        }
      }
      if (kind === "Actor") children(data.items, "items", "Item");
      if (["Item", "Actor"].includes(kind)) children(data.effects, "effects", "ActiveEffect");
      if (kind === "Item") {
        children(data.system?.activities, "system/activities", "Activity");
        const activities = data.system?.activities;
        for (const [key, activity] of collectionEntries(activities)) {
          if (!object(activity)) continue;
          const base = atPointer(`${pointer}/system/activities`, key), activityContext = record.anchors.get(base);
          for (const [index, ref] of collectionEntries(activity.effects)) {
            const refPointer = atPointer(`${base}/effects`, index);
            if (present(ref?.uuid)) reference(record, data, ref.uuid, `${refPointer}/uuid`, "dangling-activity-effect-ref", activityContext, false, true);
            else reference(record, data, ref?._id, `${refPointer}/_id`, "dangling-activity-effect-ref", activityContext);
            for (const [field, rule] of [["activity", "dangling-activity-ref"], ["effect", "dangling-activity-effect-ref"]])
              collectionEntries(ref?.riders?.[field]).forEach(([i, id]) => reference(record, data, id, atPointer(`${refPointer}/riders/${field}`, i), rule, activityContext));
          }
          if (activity.type === "forward") reference(record, data, activity.activity?.id, `${base}/activity/id`, "dangling-activity-ref", activityContext);
          reference(record, data, activity.otherActivityId, `${base}/otherActivityId`, "dangling-activity-ref", activityContext, true);
          reference(record, data, activity.midiProperties?.triggeredActivityId, `${base}/midiProperties/triggeredActivityId`, "dangling-activity-ref", activityContext, true, true);
        }
        collectionEntries(data.flags?.dnd5e?.riders?.activity).forEach(([i, id]) => reference(record, data, id, atPointer(`${pointer}/flags/dnd5e/riders/activity`, i), "dangling-activity-ref", context));
      }
    }
    function walk(record, value, pointer = "", context = {}) {
      context = record.anchors?.get(pointer) ?? context;
      if (object(value)) {
        if (present(value.flags?.["chris-premades"]?.info?.identifier)) totals.cprIdentifiers++;
        for (const namespace of ["midi-qol", "dae"]) {
          const flags = value.flags?.[namespace];
          if (object(flags) && Object.keys(flags).length) add(namespace === "dae" ? "dae-flags" : "midi-flags", record, `${pointer}/flags/${namespace}`, `Review ${namespace} flags`, context);
        }
      }
      for (const [key, child] of collectionEntries(value)) {
        const childPointer = atPointer(pointer, key);
        if (/\/flags\/dae\/specialDuration$/.test(childPointer) && Array.isArray(child) && child.length) add("dae-special-duration", record, childPointer, `Event durations: ${child.join(", ")}`, context);
        if (/\/flags\/midi-qol\/(?:advantage|disadvantage)(?:\/|$)/.test(childPointer) && !object(child)) add("midi-roll-advantage", record, childPointer, "Midi roll mode requires semantic review", context);
        if (/\/flags\/midi-qol\/OverTime$/.test(childPointer) && present(child)) add("midi-overtime", record, childPointer, "Midi OverTime depends on workflow semantics", context);
        if (typeof child === "string") {
          if (["command", "script"].includes(key)) script(record, child, childPointer, context);
          else reviewText(record, child, childPointer, context, key);
        } else if (child !== null && typeof child === "object") walk(record, child, childPointer, context);
      }
    }
    for (const record of records) {
      if (record.kind !== "Folder") document(record, record.parsed.data, record.kind);
      walk(record, record.parsed.data);
    }
    walk(manifestRecord, manifest);
    const scriptsDir = path.join(moduleDir, "scripts");
    for (const filename of await filesUnder(scriptsDir, /\.(?:mjs|js)$/i)) {
      const record = await read(filename, false); if (record) { totals.scripts++; script(record, record.text); }
    }
    const mapping = await read(path.join(moduleDir, "cpr-mapping.json"));
    if (mapping) {
      if (!Array.isArray(mapping.parsed.data)) throw new Error("cpr-mapping.json must be an array");
      const mapped = new Set();
      for (const [index, entry] of mapping.parsed.data.entries()) {
        totals.cprMappingEntries++;
        if (!object(entry)) throw new Error(`Invalid CPR mapping entry ${index}`);
        const pointer = atPointer("", index), key = `${entry.collection}.${entry.id}`;
        const prefix = `${manifest.id}.`, pack = typeof entry.collection === "string" && entry.collection.startsWith(prefix) ? packs.get(entry.collection.slice(prefix.length)) : null;
        const target = pack?.documents.get(entry.id)?.parsed.data;
        if (!target || target.flags?.["chris-premades"]?.info?.identifier !== entry.identifier || mapped.has(key))
          add("cpr-mapping-ref", mapping, pointer, `Missing, mismatched or duplicate CPR mapping: ${key}`, { documentId: entry.id });
        mapped.add(key);
      }
    }
  } catch (error) { failed = true; add("audit-input-error", { path: "dnd5e_classpack", parsed: null }, "", error.message); }
  findings.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  const ruleCounts = Object.fromEntries(Object.keys(RULES).map(rule => [rule, findings.filter(f => f.rule === rule).length]));
  const summary = { errors: findings.filter(f => f.severity === "ERROR").length, reviews: findings.filter(f => f.severity === "REVIEW").length,
    info: Object.keys(totals).length, totals, ruleCounts };
  const fingerprint = createHash("sha256").update([...inputs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([filename, hash]) => `${filename}\0${hash}\n`).join("")).digest("hex");
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), target: { foundry: "14.368", dnd5e: "6.0.x", midi: "14.6.x", dae: "14.6.x", aura: "2.x" },
    complete: !failed, exitCode: failed ? 2 : summary.errors ? 1 : 0, source: { fileCount: inputs.size, sha256: fingerprint }, summary,
    limitations: ["Static sources only; no macros or migrations executed", "Localized activity identifiers and external UUIDs require REVIEW",
      "JavaScript lexical scan does not evaluate aliases or computed expressions", "Formula context is UNKNOWN until semantic validation"], findings };
}

export function formatReport(report) {
  const lines = [`ClassPack V14 audit — ${report.complete ? "complete" : "INCOMPLETE"}`,
    `ERROR ${report.summary.errors} | REVIEW ${report.summary.reviews} | exit ${report.exitCode}`,
    `Source SHA256: ${report.source.sha256}`, "", "INFO totals:"];
  for (const [key, value] of Object.entries(report.summary.totals)) lines.push(`  ${key}: ${value}`);
  lines.push("", "Rules (full findings in v14-audit.json):");
  for (const [rule, count] of Object.entries(report.summary.ruleCounts)) {
    lines.push(`  ${RULES[rule]} ${rule}: ${count}`);
    for (const finding of report.findings.filter(f => f.rule === rule).slice(0, 5)) lines.push(`    ${finding.path}:${finding.line}:${finding.column} ${finding.jsonPointer} — ${finding.message}`);
    if (count > 5) lines.push(`    ... ${count - 5} more`);
  }
  lines.push("", "REVIEW requires semantic/runtime validation; it does not automatically mean invalid data.", ...report.limitations.map(value => `- ${value}`));
  return lines.join("\n") + "\n";
}

async function safeOutput(root, out) {
  // Check existing ancestors without creating anything first, including junctions.
  let ancestor = out;
  const suffix = [];
  while (true) {
    try { ancestor = await fs.realpath(ancestor); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; suffix.unshift(path.basename(ancestor)); const parent = path.dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; }
  }
  const canonical = path.join(ancestor, ...suffix), moduleDir = path.join(root, "dnd5e_classpack");
  for (const forbidden of [moduleDir, path.join(root, ".git"), path.join(root, "tools"), path.join(root, ".github")]) {
    let target = forbidden; try { target = await fs.realpath(forbidden); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (within(target, canonical) || within(canonical, target)) throw new Error("Report directory overlaps source or repository metadata");
  }
  return canonical;
}

export async function main(args = process.argv.slice(2)) {
  const defaultRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  let root = defaultRoot, out;
  try {
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (flag === "--help") { console.log("Usage: node tools/audit-v14.mjs [--strict] [--root REPOSITORY] [--out REPORT_DIRECTORY]\nReads dnd5e_classpack sources; writes v14-audit.json and v14-audit.txt (default: reports/).\nExit: 0 = REVIEW only or clean; 1 = ERROR; 2 = incomplete scan or invalid invocation.\n--strict explicitly requests the release gate; ERROR always exits 1."); return 0; }
      if (flag === "--strict") continue;
      if (!["--root", "--out"].includes(flag) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Invalid option ${flag}`);
      if (flag === "--root") root = path.resolve(args[++index]); else out = path.resolve(args[++index]);
    }
    root = path.resolve(root); out = await safeOutput(root, out ?? path.join(root, "reports"));
    const report = await auditRepository(root);
    await fs.mkdir(out, { recursive: true });
    for (const [name, content] of [["v14-audit.json", JSON.stringify(report, null, 2) + "\n"], ["v14-audit.txt", formatReport(report)]]) {
      const filename = path.join(out, name);
      try { const stat = await fs.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error(`Unsafe report target ${filename}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await fs.writeFile(filename, content, "utf8");
    }
    console.log(`ERROR ${report.summary.errors} | REVIEW ${report.summary.reviews} | exit ${report.exitCode}\nReports: ${out}`);
    return report.exitCode;
  } catch (error) { console.error(`audit-v14: ${error.message}`); return 2; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
