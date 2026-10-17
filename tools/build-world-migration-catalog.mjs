import fs from "node:fs/promises";
import path from "node:path";
import {execFileSync} from "node:child_process";
import assert from "node:assert/strict";
import {isDeepStrictEqual} from "node:util";
import {fileURLToPath} from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = args => execFileSync("git", ["-c", "core.autocrlf=false", ...args], {cwd: repo, encoding: "utf8"});
const baseline = "274c9685";
const semantic = "da816aa8";
const cleanup = "4b33aff0";
const intermediate = "ded66f41";
const intermediateFiles = new Set(git(["diff","--name-only","-z",intermediate,semantic,"--","dnd5e_classpack/packs"]).split("\0").filter(Boolean));
const files = [...new Set([
  ...git(["diff", "--name-only", "-z", baseline, semantic, "--", "dnd5e_classpack/packs"]).split("\0"),
  ...git(["diff", "--name-only", "-z", `${cleanup}^`, cleanup, "--", "dnd5e_classpack/packs"]).split("\0")
].filter(p => p.endsWith(".json")))].sort();
const read = (revision, file) => JSON.parse(git(["show", `${revision}:${file}`]));
const entries = [];
const state = (object, key) => Object.hasOwn(object, key) ? {present: true, value: object[key]} : {present: false};
function differences(before, after, prefix = "") {
  const patches = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (["_id", "_key", "_stats", "effects", "items"].includes(key) && !prefix) continue;
    assert.ok(!key.includes(".") && !key.startsWith("-="), "Unsafe field key");
    const old = state(before, key), next = state(after, key), field = prefix + key;
    if (isDeepStrictEqual(old, next)) continue;
    const plain = v => v && typeof v === "object" && !Array.isArray(v);
    if (old.present && next.present && plain(old.value) && plain(next.value)) {
      patches.push(...differences(old.value, next.value, field + "."));
    } else patches.push({path: field, before: old, after: next});
  }
  return patches;
}
function collect(before, after, source, container = null, middle = null) {
  assert.equal(before._id, after._id);
  const targets = [];
  const itemFields = differences(before, after);
  if (itemFields.length) targets.push({kind: "Item", patches: itemFields});
  assert.deepEqual(before.effects.map(e => e._id), after.effects.map(e => e._id));
  for (const old of before.effects) {
    const next = after.effects.find(e => e._id === old._id);
    const patches = differences(old, next);
    if (patches.length) targets.push({kind: "ActiveEffect", id: old._id, type: old.type, patches});
  }
  for (const target of targets) {
    const data = target.kind === "Item" ? middle : middle?.effects?.find(e=>e._id===target.id);
    if (!data) continue;
    for (const patch of target.patches) {
      let value=data, present=true;
      for (const key of patch.path.split(".")) {
        if (!value || !Object.hasOwn(value,key)) {present=false;break;}
        value=value[key];
      }
      const known=present?{present:true,value}:{present:false};
      if (!isDeepStrictEqual(known,patch.before) && !isDeepStrictEqual(known,patch.after)) patch.beforeAlternatives=[{revision:intermediate,state:known}];
    }
  }
  if (targets.length) entries.push({source, container, itemId: before._id, itemType: before.type, name: after.name, targets});
}
for (const file of files) {
  const before = read(baseline, file), after = read(semantic, file);
  const middle = intermediateFiles.has(file) ? read(intermediate,file) : null;
  // The alpha.4 additions await runtime validation; they are deliberately absent.
  if (["n9RjfSJ88RfFhO1T", "BLNE7S7l2uTkx7w6"].includes(after._id)) {
    const cleaned = read(cleanup, file);
    after.system.activities.dnd5eactivity000.effects = cleaned.system.activities.dnd5eactivity000.effects;
  }
  const pack = file.split("/")[2];
  if (before.items) {
    for (const old of before.items) {
      const next = after.items.find(i => i._id === old._id);
      assert.ok(next);
      const actor = `Compendium.dnd5e_classpack.${pack}.Actor.${before._id}`;
      collect(old, next, `${actor}.Item.${old._id}`, actor, middle?.items.find(i=>i._id===old._id));
    }
  } else collect(before, after, `Compendium.dnd5e_classpack.${pack}.Item.${before._id}`, null, middle);
}
const macroBaseline = "12233a31";
for (const file of git(["diff","--name-only","-z",macroBaseline,cleanup,"--","dnd5e_classpack/packs/macro"]).split("\0").filter(p=>p.endsWith(".json"))) {
  const before = read(macroBaseline,file), after = read(cleanup,file);
  if (before.command === after.command) continue;
  assert.equal(before._id,after._id);
  entries.push({documentName:"Macro",baseline:macroBaseline,source:`Compendium.dnd5e_classpack.macro.Macro.${before._id}`,
    container:null,itemId:before._id,itemType:before.type,name:after.name,
    targets:[{kind:"Macro",patches:[{path:"command",before:{present:true,value:before.command},after:{present:true,value:after.command}}]}]});
}
assert.ok(entries.length > 250);
const catalog = {version: 2, baseline, semantic, cleanup, intermediate, entries,
  deferred: ["alpha.4 semantic additions, including Tortle AC", "alpha.7 source repairs await runtime validation", "unknown midi/DAE/CPR semantics", "active Actor effects are preserved; only owned Item templates and reviewed Macro commands are patched"]};
const output = path.join(repo, "dnd5e_classpack/scripts/migrations/catalog.mjs");
await fs.mkdir(path.dirname(output), {recursive: true});
const {entries: rows, ...metadata} = catalog;
await fs.writeFile(output, "// Generated from reviewed semantic commits; no DataModel schema migration is simulated.\nexport const catalog = {\n  "
  + JSON.stringify(metadata).slice(1,-1) + ",\n  \"entries\": [\n" + rows.map(e=>"    "+JSON.stringify(e)).join(",\n") + "\n  ]\n};\n");
console.log(JSON.stringify({entries: entries.length, targets: entries.reduce((n,e)=>n+e.targets.length,0), fields: entries.reduce((n,e)=>n+e.targets.reduce((n,t)=>n+t.patches.length,0),0), bytes: (await fs.stat(output)).size}));
