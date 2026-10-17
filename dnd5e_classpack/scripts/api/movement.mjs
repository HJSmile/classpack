/** V14 movement actions distinguish displacement from voluntary movement. */
export const FORCED_ACTION = "classpackForced";
export const TELEPORT_ACTION = "displace";

export function registerMovementActions() {
  CONFIG.Token.movement.actions[FORCED_ACTION] = {
    label: "ClassPack 强制位移", icon: "fa-solid fa-arrows-up-down-left-right",
    canSelect: false, teleport: false, measure: false, costMultiplier: 0,
    terrainAction: null, walls: "move", visualize: false
  };
}

/** Resolve the originating scene explicitly, including on a GM viewing another scene. */
export async function moveTokens(sceneId, updates, { teleport = false, animate = true, animation, pan = false } = {}) {
  const scene = game.scenes.get(sceneId);
  if (!scene) throw new Error(`ClassPack: scene ${sceneId} is unavailable.`);
  if (!updates?.length) return {};
  const action = teleport ? TELEPORT_ACTION : FORCED_ACTION;
  const instructions = {};
  for (const update of updates) {
    const { _id, ...destination } = update;
    if (!scene.tokens.has(_id)) throw new Error(`ClassPack: token ${_id} is not in scene ${sceneId}.`);
    if (!Number.isFinite(destination.x) || !Number.isFinite(destination.y)
      || (destination.elevation !== undefined && !Number.isFinite(destination.elevation))) {
      throw new Error("ClassPack: invalid movement destination.");
    }
    instructions[_id] = { destination: { ...destination, action }, autoRotate: false, showRuler: false };
  }
  const options = { method: "api", animate, pan };
  if (animation && typeof animation === "object") options.animation = animation;
  return scene.moveTokens(instructions, options);
}
