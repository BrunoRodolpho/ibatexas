/**
 * Pure seed data — no Medusa imports.
 * Exported separately so tests can import it without requiring the Medusa runtime.
 */
export type ProductType = "food" | "frozen" | "merchandise";
export type AvailabilityWindow = "almoco" | "jantar" | "congelados" | "always";
export interface NutritionalInfo {
    calories: number;
    protein: number;
    fat: number;
    carbs: number;
    sodium: number;
}
export interface SeedVariant {
    title: string;
    /** Price in centavos BRL — e.g. R$89,00 = 8900 */
    price: number;
}
export interface SeedProduct {
    title: string;
    handle: string;
    description: string;
    categoryHandle: string;
    tags: string[];
    variants: SeedVariant[];
    metadata: {
        productType: ProductType;
        availabilityWindow: AvailabilityWindow;
        preparationTime?: number;
        nutritionalInfo: NutritionalInfo;
        allergens: string[];
    };
}
export declare const CATEGORIES: readonly [{
    readonly name: "Restaurante";
    readonly handle: "restaurante";
    readonly parent: null;
}, {
    readonly name: "Carnes Defumadas";
    readonly handle: "carnes-defumadas";
    readonly parent: "restaurante";
}, {
    readonly name: "Acompanhamentos";
    readonly handle: "acompanhamentos";
    readonly parent: "restaurante";
}, {
    readonly name: "Sanduíches & Combos";
    readonly handle: "sanduiches";
    readonly parent: "restaurante";
}, {
    readonly name: "Sobremesas";
    readonly handle: "sobremesas";
    readonly parent: "restaurante";
}, {
    readonly name: "Bebidas";
    readonly handle: "bebidas";
    readonly parent: "restaurante";
}, {
    readonly name: "Congelados";
    readonly handle: "congelados";
    readonly parent: "restaurante";
}];
export declare const SEED_PRODUCTS: SeedProduct[];
//# sourceMappingURL=seed-data.d.ts.map