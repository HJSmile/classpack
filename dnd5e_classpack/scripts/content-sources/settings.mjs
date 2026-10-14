import { MODULE_ID } from "./policy.mjs";

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
      const rows = Object.entries(catalog.books).sort(([a], [b]) => a.localeCompare(b)).map(([book, label]) =>
        `<label style="display:flex;align-items:center;gap:8px"><input type="checkbox" name="sources.${escape(book)}" ${values[book] !== false ? "checked" : ""}>${escape(label)}</label>`).join("");
      return `<p>来源开关控制合集浏览器与新升级候选。多个来源共用的条目只需开启其中一个来源；未知来源保留可见，角色已有物品不受影响。</p><p>D&D Beyond 自制专长归入第三方内容。法表的获得资格也会核对，例如 PHB 法术凭 TCE 扩展进入其他职业法表。保存后请重载。</p><div style="display:flex;gap:8px;margin-bottom:12px"><button type="button" data-action="all">全部开启</button><button type="button" data-action="core">仅 PHB／DMG</button></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:55vh;overflow:auto">${rows}</div><footer style="margin-top:16px"><button type="submit"><i class="fas fa-save"></i> 保存</button></footer>`;
    }
    _replaceHTML(result, content) { content.innerHTML = result; }
    static all() { for (const box of this.element.querySelectorAll('input[type="checkbox"]')) box.checked = true; }
    static core() { for (const box of this.element.querySelectorAll('input[type="checkbox"]')) box.checked = ["sources.PHB", "sources.DMG"].includes(box.name); }
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
