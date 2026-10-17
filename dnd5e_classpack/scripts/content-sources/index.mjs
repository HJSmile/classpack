import { MODULE_ID, createContentPolicy, sourceBooks } from "./policy.mjs";
import { registerContentSettings, getContentSettings } from "./settings.mjs";
import { installContentFiltering } from "./runtime.mjs";

let catalog, loadError;
// This read begins when the module loads; init waits for the same promise.
const loaded = fetch(`modules/${MODULE_ID}/scripts/content-sources/catalog.json`).then(response => {
  if (!response.ok) throw new Error(`来源目录读取失败 (${response.status})`);
  return response.json();
}).then(data => { catalog = data; }).catch(error => { loadError = error; });

await loaded;
Hooks.once("init", () => {
  if (loadError) { console.error(`[${MODULE_ID}]`, loadError); return; }
  registerContentSettings(catalog);
});
Hooks.once("ready", async () => {
  await loaded;
  if (!catalog || game.system.id !== "dnd5e") return;
  const policy = createContentPolicy(catalog, getContentSettings), module = game.modules.get(MODULE_ID);
  try {
    await dnd5e.registry.spellLists.register(catalog.dunamancy.page);
    const status = installContentFiltering(policy);
    module.api ??= {};
    module.api.contentSources = { policy, status, inspect: () => ({ ...status, settings: getContentSettings(),
      indexed: Object.keys(catalog.entries).length, unknown: Object.values(catalog.entries).filter(s => !sourceBooks(s).length).length }) };
  } catch (error) { console.error(`[${MODULE_ID}] 内容来源初始化失败`, error); }
});
