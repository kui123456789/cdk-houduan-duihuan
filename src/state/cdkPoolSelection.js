import { CDK_POOLS, parseCdkeyPools } from "../domain/accountParsing.js";

function getExcludedPoolIds(options = {}) {
  const excluded = options.excludePoolIds ?? options.excludePoolId ?? options.exclude;
  return new Set(
    (Array.isArray(excluded) ? excluded : [excluded])
      .map((poolId) => String(poolId || "").trim())
      .filter(Boolean)
  );
}

export function buildCdkPoolChoices(cdkeyPools, options = {}) {
  const source = cdkeyPools && typeof cdkeyPools === "object" ? cdkeyPools : {};
  const excludedPoolIds = getExcludedPoolIds(options);

  return CDK_POOLS
    .filter((pool) => !excludedPoolIds.has(pool.id))
    .map((pool) => {
      const text = String(source[pool.id] || "");
      const { cdkeys } = parseCdkeyPools([{ ...pool, text }]);

      return {
        ...pool,
        count: cdkeys.length,
        text
      };
    })
    .filter((choice) => choice.count > 0);
}

export function chooseSubmitPoolDecision(cdkeyPools, options = {}) {
  const choices = buildCdkPoolChoices(cdkeyPools, options);

  if (choices.length === 0) {
    return { kind: "empty", choices };
  }

  if (choices.length === 1) {
    return {
      kind: "direct",
      poolId: choices[0].id,
      choice: choices[0],
      choices
    };
  }

  return { kind: "prompt", choices };
}

export function restrictCdkeyPoolsToPool(cdkeyPools, poolId) {
  const source = cdkeyPools && typeof cdkeyPools === "object" ? cdkeyPools : {};
  const selectedPoolId = String(poolId || "");

  return Object.fromEntries(
    CDK_POOLS.map((pool) => [pool.id, pool.id === selectedPoolId ? String(source[pool.id] || "") : ""])
  );
}
