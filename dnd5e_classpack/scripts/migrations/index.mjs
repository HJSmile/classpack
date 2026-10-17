import {catalog} from "./catalog.mjs";
import {equal, fieldState, renameReferences, provenance, evaluateTargets} from "./patches.mjs";

const MODULE_ID = "dnd5e_classpack";
const VERSION = "migrationVersion";
const LEGACY = "newIconToSpellMigrated";
const ROOTS = ["actors", "items", "journal", "macros", "tables", "scenes", "playlists", "folders"];
export const registry = Object.freeze([
  {version: 1, id: "new-icon-to-spell"},
  {version: 2, id: "fvtt14-dnd6-reviewed-fields"}
]);
const bySource = new Map(catalog.entries.map(e=>[e.source,e]));
let running = false;

export function registerMigrationSettings() {
  game.settings.register(MODULE_ID, LEGACY, {name: "new-icon → spell 迁移标记", scope: "world", config: false, type: Boolean, default: false});
  game.settings.register(MODULE_ID, VERSION, {name: "ClassPack 世界迁移版本", scope: "world", config: false, type: Number, default: 0});
}
function currentVersion() {
  const value = game.settings.get(MODULE_ID, VERSION);
  if (!Number.isInteger(value) || value < 0 || value > registry.at(-1).version) throw new Error("无法识别世界迁移版本，请保留原设置并检查模块版本。");
  return value;
}
function requireEnvironment() {
  if (!game.user?.isGM) throw new Error("只有 GM 可以检查或迁移世界。");
  if (Number(game.release?.generation) !== 14 || game.system?.id !== "dnd5e" || !/^6\.0\./.test(game.system.version)) {
    throw new Error("世界迁移需要 FVTT 14 和 dnd5e 6.0.x。");
  }
}
function requireWriter() {
  const activeGM = game.users.activeGM ?? [...game.users].filter(u=>u.isGM && u.active).sort((a,b)=>a.id.localeCompare(b.id))[0];
  if (activeGM?.id !== game.user.id) throw new Error("请由当前 active GM 执行，避免多个 GM 同时迁移。");
}
function documents() {
  const result = [], seen = new Set();
  function visit(doc) {
    if (!doc || seen.has(doc.uuid) || doc.inCompendium) return;
    seen.add(doc.uuid); result.push(doc);
    for (const [kind,field] of Object.entries(doc.constructor.metadata?.embedded ?? {})) {
      if (kind === "ActorDelta") continue;
      const embedded = doc[field];
      if (embedded?.contents) for (const child of embedded.contents) visit(child);
      else if (embedded?.documentName) visit(embedded);
    }
  }
  for (const name of ROOTS) for (const doc of game[name]?.contents ?? []) visit(doc);
  // A synthetic Actor writes through ActorDelta, preserving the linked base Actor.
  for (const scene of game.scenes?.contents ?? []) for (const token of scene.tokens?.contents ?? []) {
    if (token.actorLink) continue;
    const actor = token.actor;
    if (actor?.isToken && actor.token?.id === token.id) visit(actor);
  }
  return result;
}
function legacyOperations(docs) {
  if (game.settings.get(MODULE_ID, LEGACY)) return [];
  const operations = [];
  for (const document of docs) {
    const data = document.toObject(true);
    for (const field of Object.values(document.constructor.metadata?.embedded ?? {})) delete data[field];
    const updates = renameReferences(data);
    if (!Object.keys(updates).length) continue;
    const before = Object.fromEntries(Object.keys(updates).map(p=>[p,fieldState(document.toObject(true),p)]));
    const expected = Object.entries(updates).map(([path,value])=>({path,state:{present:true,value}}));
    operations.push({document,updates,before,expected});
  }
  return operations;
}
function semanticGroups(docs) {
  const groups = [], reviews = [];
  let confirmed = 0, unchanged = 0;
  for (const item of docs.filter(d=>["Item","Macro"].includes(d.documentName))) {
    const own = provenance(item.toObject(true), item.documentName);
    let source = own.source;
    if (own.conflicting && own.classpack) {reviews.push({uuid:item.uuid,reason:"conflicting-provenance"}); continue;}
    if (item.parent?.documentName === "Actor") {
      const parent = provenance(item.parent.toObject(true), "Actor");
      const candidate = parent.source ? `${parent.source}.Item.${item.id}` : null;
      if (bySource.has(candidate)) {
        if (!own.hasSource || own.classpack) source = candidate;
        else {reviews.push({uuid:item.uuid,source:own.source,reason:"foreign-embedded-provenance",actorSource:parent.source}); continue;}
      }
    }
    const entry = bySource.get(source);
    if (!entry) continue;
    confirmed++;
    const planned = evaluateTargets(item,entry);
    reviews.push(...planned.reviews.map(r=>({uuid:item.uuid,source,...r})));
    if (planned.operations.length) groups.push({uuid:item.uuid,source,operations:planned.operations});
    else if (!planned.reviews.length) unchanged++;
  }
  return {groups,reviews,confirmed,unchanged};
}
function publicOperation(operation) {
  return {uuid:operation.document.uuid,updates:operation.updates,before:operation.before};
}
async function writeOperation(operation, report) {
  requireWriter();
  const original = operation.document.toObject(true);
  for (const [path,state] of Object.entries(operation.before)) {
    if (!equal(fieldState(original,path),state)) throw new Error(`字段在检查后发生变化：${operation.document.uuid} ${path}`);
  }
  const attempt = publicOperation(operation);
  report.writeAttempts.push(attempt);
  await operation.document.update(structuredClone(operation.updates), {diff:true,recursive:true});
  report.writes.push({...attempt,verification:"pending"});
  const saved = operation.document.toObject(true);
  for (const field of operation.expected) if (!equal(fieldState(saved,field.path),field.state)) {
    throw new Error(`字段保存后校验失败：${operation.document.uuid} ${field.path}`);
  }
  report.writes.at(-1).verification = "PASS";
}
function reportBase(mode) {
  return {mode,createdAt:new Date().toISOString(),world:game.world.id,core:game.version,system:game.system.version,
    module:game.modules.get(MODULE_ID)?.version,versionBefore:currentVersion(),versionAfter:currentVersion(),
    legacyMarkerBefore:game.settings.get(MODULE_ID,LEGACY),registry,writes:[],writeAttempts:[],errors:[],reviews:[],deferred:catalog.deferred};
}
export async function checkWorldMigrations() {
  requireEnvironment();
  const report = reportBase("check"), docs = documents();
  const legacy = legacyOperations(docs), semantic = semanticGroups(docs);
  report.documentsScanned = docs.length;
  report.pending = registry.filter(m=>m.version>report.versionBefore);
  report.legacy = {pending:!report.legacyMarkerBefore,operations:legacy.map(publicOperation)};
  report.semantic = {confirmed:semantic.confirmed,unchanged:semantic.unchanged,groups:semantic.groups.map(g=>({...g,operations:g.operations.map(publicOperation)}))};
  report.reviews = semantic.reviews;
  report.worldDocumentsWritten = 0;
  return report;
}
export async function runWorldMigrations() {
  requireEnvironment(); requireWriter();
  if (running) throw new Error("迁移已在当前客户端运行。");
  const report = reportBase("migrate");
  running = true;
  try {
    if (report.versionBefore < 1 || !report.legacyMarkerBefore) {
      for (const operation of legacyOperations(documents())) {
        try {await writeOperation(operation,report);} catch (e) {report.errors.push({uuid:operation.document.uuid,message:e.message});}
      }
      if (report.errors.length) return report;
      requireWriter();
      if (!game.settings.get(MODULE_ID,LEGACY)) await game.settings.set(MODULE_ID,LEGACY,true);
      const adopted = Math.max(report.versionBefore,1);
      await game.settings.set(MODULE_ID,VERSION,adopted); report.versionAfter = adopted;
    }
    if (report.versionBefore < 2) {
      const semantic = semanticGroups(documents());
      report.reviews = semantic.reviews;
      report.semantic = {confirmed:semantic.confirmed,unchanged:semantic.unchanged,groups:semantic.groups.length};
      for (const group of semantic.groups) {
        try {for (const operation of group.operations) await writeOperation(operation,report);}
        catch (e) {report.errors.push({uuid:group.uuid,message:e.message});}
      }
      if (!report.errors.length && !report.reviews.length) {
        requireWriter(); await game.settings.set(MODULE_ID,VERSION,2); report.versionAfter = 2;
      }
    }
  } catch (e) {report.errors.push({message:e.message});}
  finally {running = false; report.worldDocumentsWritten = report.writes.length; report.complete = report.versionAfter === registry.at(-1).version;}
  return report;
}
export function notifyPendingMigrations() {
  if (!game.user?.isGM) return;
  try {
    if (currentVersion() < registry.at(-1).version) ui.notifications.info("ClassPack 有待处理的世界迁移。请先运行世界迁移检查宏，再手动迁移。");
  } catch (e) {ui.notifications.warn(e.message);}
}
export const worldMigrations = Object.freeze({check:checkWorldMigrations,run:runWorldMigrations,registry});
