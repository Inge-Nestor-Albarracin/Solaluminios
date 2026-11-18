// Accessory families (ProductFamily.kind = ACCESSORY) are catalog only for
// now: they have no colour and are sold by unit, metre or roll, so bundles,
// lots, purchases, quotes and material requests refuse their references.

// Include for reference lookups that must know the family kind.
export const withFamilyKind = { family: { select: { kind: true } } } as const;

export const isAccessory = (reference: { family: { kind: string } | null } | null) => reference?.family?.kind === 'ACCESSORY';

export const ACCESSORY_CATALOG_ONLY =
  'es un accesorio: por ahora los accesorios solo están en el catálogo y no se registran, compran, cotizan ni solicitan';
