/** Read-only startup diagnostics; optional automation never blocks initialization. */
const MODULE_ID = "dnd5e_classpack";

export function isCompatibleVersion(version, range = {}, { core = false } = {}) {
  if (!version) return false;
  const newer = foundry.utils.isNewerVersion;
  if (range.minimum && newer(range.minimum, version)) return false;
  if (range.maximum && newer(version, range.maximum, {
    majorOnly: core && Number.isInteger(Number(range.maximum))
  })) return false;
  return true;
}

export function inspectCompatibility() {
  const manifest = game.modules.get(MODULE_ID);
  const issues = [];
  const modules = {};
  const coreVersion = game.version ?? game.release?.version;
  if (!isCompatibleVersion(coreVersion, manifest.compatibility, { core: true })) {
    issues.push({ severity: "ERROR", id: "foundry", message: `需要 Foundry 14.368+（V14），当前为 ${coreVersion ?? "未知"}。` });
  }
  const system = Array.from(manifest.relationships.systems).find(entry => entry.id === "dnd5e");
  if (game.system.id !== "dnd5e" || !isCompatibleVersion(game.system.version, system?.compatibility)) {
    issues.push({ severity: "ERROR", id: "dnd5e", message: `需要 dnd5e 6.0.x，当前为 ${game.system.id} ${game.system.version}。` });
  }
  for (const relation of ["requires", "recommends"]) {
    for (const requirement of manifest.relationships[relation] ?? []) {
      const installed = game.modules.get(requirement.id);
      const compatible = isCompatibleVersion(installed?.version, requirement.compatibility);
      const available = Boolean(installed?.active && compatible);
      modules[requirement.id] = {
        active: Boolean(installed?.active), version: installed?.version ?? null,
        compatible, available, optional: relation === "recommends"
      };
      if (available) continue;
      const expected = requirement.compatibility?.minimum ?? "兼容版本";
      const status = !installed ? "未安装" : !installed.active ? "未启用" : `版本不兼容（${installed.version}）`;
      const impact = relation === "recommends" ? "依赖它的内容自动化不可用；ClassPack 基础 API 继续初始化" : "相关功能不可用，请检查必需依赖";
      issues.push({ severity: relation === "recommends" ? "REVIEW" : "ERROR", id: requirement.id,
        message: `${requirement.id} ${status}；需要 ${expected}+ 的目标兼容线。${impact}。` });
    }
  }
  return { coreVersion, systemVersion: game.system.version, modules, issues };
}

export function checkCompatibility() {
  const report = inspectCompatibility();
  for (const issue of report.issues) console.warn(`[${MODULE_ID}] ${issue.severity}: ${issue.message}`);
  if (report.issues.length && game.user.isGM) {
    ui.notifications.warn(`ClassPack 6.0.x 兼容检查：${report.issues.map(issue => issue.message).join(" ")}`);
  }
  return report;
}
