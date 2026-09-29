const MAX_MONEY_CENTS = 2_147_483_647n;

/** Converts a non-negative decimal amount to integer cents without binary-float rounding. */
export function parseMoneyCents(value: unknown): number | undefined {
  const decimal = typeof value === 'number'
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : '';
  const match = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(decimal);
  if (!match || decimal.length > 64) return undefined;

  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent)) return undefined;

  const unscaled = BigInt(`${match[1]}${fraction}`);
  if (unscaled === 0n) return 0;

  const decimalPlaces = fraction.length - exponent;
  let cents: bigint;
  if (decimalPlaces <= 2) {
    const scale = 2 - decimalPlaces;
    if (scale > 18) return undefined;
    cents = unscaled * (10n ** BigInt(scale));
  } else {
    const digitsToRound = decimalPlaces - 2;
    if (digitsToRound > 64) return 0;
    const divisor = 10n ** BigInt(digitsToRound);
    cents = (unscaled + divisor / 2n) / divisor;
  }

  return cents <= MAX_MONEY_CENTS ? Number(cents) : undefined;
}
