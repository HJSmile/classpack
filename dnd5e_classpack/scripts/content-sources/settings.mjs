import { MODULE_ID } from "./policy.mjs";

const CORE_SOURCES = ["PHB", "DMG", "MM"];
const ADVENTURE_SOURCES = new Set(["DSotDQ", "ToA", "BGDiA", "WBtW", "OotA", "GoS", "HotDQ", "CoS",
  "WDMM", "IDRotF", "TftYP", "PotA", "SKT", "WDH", "RoT", "LMoP", "HftT", "LR", "LLK", "DoDk", "CM"]);
const CAMPAIGN_SOURCES = new Set(["AAG", "AI", "BAM", "EGW", "ERLW", "GGR", "MOT", "MPP", "SCAG", "SCC", "SO", "VRGR", "WGE"]);
const PARTNER_SOURCES = new Set(["BH", "BoET", "DDB-HB", "GH", "HCS", "OTTG", "TCSR", "TGS", "VSS"]);

let cachedSettings;
const invalidateSettings = () => { cachedSettings = undefined; };
export function getContentSettings() {
  return cachedSettings ??= Object.freeze({ enabled: game.settings.get(MODULE_ID, "contentSourceFiltering"),
    sources: Object.freeze({ ...game.settings.get(MODULE_ID, "contentSources") ?? {} }),
    ua: game.settings.get(MODULE_ID, "contentUA"), thirdParty: game.settings.get(MODULE_ID, "contentThirdParty"),
    dunamancy: game.settings.get(MODULE_ID, "contentDunamancyPermission") });
}

export function registerContentSettings(catalog) {
  for (const [key, name, hint, value] of [
    ["contentSourceFiltering", "按内容来源过滤", "控制 dnd5e 合集浏览器和新升级候选；已获得的固定能力保留。", true],
    ["contentUA", "允许 UA 内容", "显示并允许选择 ClassPack 中的未定之奥秘内容。", true],
    ["contentThirdParty", "允许第三方内容", "显示并允许选择 ClassPack 中的第三方内容。", true],
    ["contentDunamancyPermission", "允许其他职业选择秘迹学法术", "默认仅时间魔法与重力魔法子职业可选择；开启表示 DM 许可其他施法职业选择。", false]
  ]) game.settings.register(MODULE_ID, key, { name, hint, scope: "world", config: true, type: Boolean, default: value, requiresReload: true, onChange: invalidateSettings });
  game.settings.register(MODULE_ID, "contentSources", { scope: "world", config: false, type: Object, default: {}, requiresReload: true, onChange: invalidateSettings });
  const { ApplicationV2 } = foundry.applications.api;
  class ContentSourceConfig extends ApplicationV2 {
    static DEFAULT_OPTIONS = { id: "classpack-content-sources", tag: "form", window: { title: "ClassPack 内容来源" },
      position: { width: 560, height: "auto" }, form: { closeOnSubmit: true, handler: ContentSourceConfig.save },
      actions: { all: ContentSourceConfig.all, core: ContentSourceConfig.core } };
    async _renderHTML() {
      const values = getContentSettings().sources, escape = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const groups = [["核心", []], ["扩展", []], ["模组", []]];
      for (const entry of Object.entries(catalog.books).sort(([a], [b]) => a.localeCompare(b))) {
        groups[CORE_SOURCES.includes(entry[0]) ? 0 : ADVENTURE_SOURCES.has(entry[0]) ? 2 : 1][1].push(entry);
      }
      groups[0][1].sort(([a], [b]) => CORE_SOURCES.indexOf(a) - CORE_SOURCES.indexOf(b));
      const expansions = [["规则扩展", []], ["战役设定", []], ["合作内容", []]];
      for (const entry of groups[1][1]) expansions[CAMPAIGN_SOURCES.has(entry[0]) ? 1 : PARTNER_SOURCES.has(entry[0]) ? 2 : 0][1].push(entry);
      const rows = books => `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">${books.map(([book, label]) =>
        `<label style="display:flex;align-items:center;gap:8px;overflow-wrap:anywhere"><input style="flex-shrink:0" type="checkbox" name="sources.${escape(book)}" ${values[book] !== false ? "checked" : ""}>${escape(label)}</label>`).join("")}</div>`;
      const sections = groups.map(([name, books]) => `<fieldset style="margin:0 0 12px;padding:8px 12px 12px"><legend style="font-weight:600">${name}</legend>${name === "扩展"
        ? expansions.filter(([, entries]) => entries.length).map(([title, entries]) => `<section style="margin-bottom:12px"><h3 style="font-size:inherit;margin:4px 0 8px">${title}</h3>${rows(entries)}</section>`).join("")
        : rows(books)}</fieldset>`).join("");
      return `<div style="display:flex;gap:8px;margin-bottom:12px"><button type="button" data-action="all">全部开启</button><button type="button" data-action="core">仅核心</button></div><div style="max-height:55vh;overflow:auto">${sections}</div><footer style="margin-top:16px"><button type="submit"><i class="fas fa-save"></i> 保存</button></footer>`;
    }
    _replaceHTML(result, content) { content.innerHTML = result; }
    static all() { for (const box of this.element.querySelectorAll('input[type="checkbox"]')) box.checked = true; }
    static core() { for (const box of this.element.querySelectorAll('input[type="checkbox"]')) box.checked = CORE_SOURCES.some(book => box.name === `sources.${book}`); }
    static async save(event, form) {
      const before = getContentSettings().sources, values = { ...before };
      for (const box of form.querySelectorAll('input[type="checkbox"]')) values[box.name.slice(8)] = box.checked;
      await game.settings.set(MODULE_ID, "contentSources", values);
      game.settings.sheet?.render?.();
      if (JSON.stringify(before) !== JSON.stringify(values)) await foundry.applications.settings.SettingsConfig.reloadConfirm({ world: true });
    }
  }
  game.settings.registerMenu(MODULE_ID, "contentSourceMenu", { name: "内容来源", label: "选择启用的书籍", hint: "按书籍控制 ClassPack 内容。", icon: "fas fa-book", type: ContentSourceConfig, restricted: true });
}
