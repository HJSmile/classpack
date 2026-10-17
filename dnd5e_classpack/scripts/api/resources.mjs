/** Serialized, reversible item-use transactions shared by roll interventions and other APIs. */
export function createResourceApi(api) {
  let queue = Promise.resolve();
  const completed = new Map();
  function remaining(item) {
    return Math.max(0, Number(item?.system?.uses?.max ?? 0) - Number(item?.system?.uses?.spent ?? 0));
  }
  function runExclusive(operation) {
    const job = queue.then(operation);
    queue = job.catch(() => {});
    return job;
  }
  async function commitLocal(costs) {
    if (!game.user.isGM) throw new Error('Resource transactions must execute on the GM.');
    const amounts = new Map();
    for (const { itemUuid, amount = 1 } of costs) {
      if (!Number.isInteger(amount) || amount < 0) throw new Error('Resource cost must be a non-negative integer.');
      amounts.set(itemUuid, (amounts.get(itemUuid) ?? 0) + amount);
    }
    const entries = [];
    for (const [uuid, amount] of amounts) {
      const item = await fromUuid(uuid);
      if (!item?.actor || !Number.isFinite(remaining(item)) || remaining(item) < amount) throw new Error('Resource is missing or exhausted.');
      const before = Number(item.system.uses.spent ?? 0);
      entries.push({ itemUuid: uuid, before, after: before + amount });
    }
    const applied = [];
    try {
      for (const entry of entries) {
        await (await fromUuid(entry.itemUuid)).update({ 'system.uses.spent': entry.after });
        applied.push(entry);
      }
    } catch (error) {
      await refundLocal({ entries: applied });
      throw error;
    }
    return { entries };
  }
  async function refundLocal(receipt) {
    if (!game.user.isGM) throw new Error('Refunds must execute on the GM.');
    for (const entry of [...receipt.entries].reverse()) {
      const item = await fromUuid(entry.itemUuid);
      // Never overwrite a long rest or an unrelated change made outside this transaction.
      if (!item || Number(item.system.uses.spent) !== entry.after) throw new Error('Resource changed externally; automatic refund stopped.');
      await item.update({ 'system.uses.spent': entry.before });
    }
  }
  async function consumeOnGM(request) {
    return runExclusive(async () => {
      if (!game.user.isGM) throw new Error('Resource transactions must execute on the GM.');
      const user = game.users.get(request.requester);
      if (!user?.active || !request.id) throw new Error('Invalid resource request.');
      for (const cost of request.costs) {
        const item = await fromUuid(cost.itemUuid);
        if (!item?.actor || (!user.isGM && !item.actor.testUserPermission(user, 'OWNER'))) throw new Error('No permission to consume this resource.');
      }
      const key = `${user.id}:${request.id}`;
      if (completed.has(key)) return completed.get(key);
      const receipt = await commitLocal(request.costs);
      completed.set(key, receipt);
      if (completed.size > 1000) completed.delete(completed.keys().next().value);
      return receipt;
    });
  }
  async function consume(costs, { id = foundry.utils.randomID() } = {}) {
    const gm = game.users.activeGM;
    if (!gm || !api.socket) throw new Error('Resource transactions require an online GM and ClassPack socket.');
    return api.socket.executeAsUser('resourceConsume', gm.id, { id, requester: game.user.id, costs });
  }
  return Object.freeze({ remaining, runExclusive, commitLocal, refundLocal, consumeOnGM, consume });
}
