// Peso amounts as people type them in Colombia, to the plain decimal the API
// expects ("12000.5"):
//   «12.000» «$ 12.000» «1.500,50» «1500,5» «1500.50» «12000»
// - With a comma, the comma is the decimal mark and dots group thousands.
// - Without a comma, dots in groups of three are thousands («12.000»,
//   «1.250.000»); any other single dot is a decimal mark («1500.5»).
// - A decimal mark still without decimals while typing («3.453,» «3453.»)
//   counts as the whole number, so totals do not jump while typing.
// Anything else is returned as typed (trimmed) so the caller rejects it.
export function parseMoney(value: string): string {
  const text = value
    .trim()
    .replace(/^\$\s*/, '')
    .replace(/\s+/g, '')
    .replace(/(?<=\d)[.,]$/, '')
  if (text.includes(',')) {
    const [whole, decimals, ...rest] = text.split(',')
    if (rest.length > 0 || !/^\d{1,3}(\.\d{3})*$|^\d+$/.test(whole)) return text
    return `${whole.replace(/\./g, '')}${decimals !== undefined ? `.${decimals}` : ''}`
  }
  if (/^\d{1,3}(\.\d{3})+$/.test(text)) return text.replace(/\./g, '')
  return text
}

// cents × percent / 100 rounded half up to a cent, exactly as the server
// does it with decimals (floats would turn $205,205 into $205,20).
export function percentOfCents(cents: number, percent: number | string): number {
  const [whole, fraction] = Number(percent).toFixed(6).split('.')
  const product = BigInt(Math.round(cents)) * BigInt(whole + fraction)
  const divisor = 100_000_000n
  return Number(product / divisor + ((product % divisor) * 2n >= divisor ? 1n : 0n))
}

