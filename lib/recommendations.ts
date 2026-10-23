// lib/recommendations.ts

export interface Product {
  id: number;
  nama: string;
  merek: string;
  kat: string;
  bpom: string;
  spf?: string;
  tekstur?: string;
  harga: number;
  tipe: string[];
  target: string[];
  bahan_raw?: string;
  fungsi?: string;
  bahan_keywords?: string[];
  bobot?: Record<string, number>;
}

export interface MatchedProduct extends Product {
  score: number;
  reasons: string[];
}

const INGREDIENTS_MAP: Record<string, string[]> = {
  jerawat: ['salicylic', 'tea tree', 'centella', 'zinc', 'niacinamide', 'sulfur'],
  flek_hitam: ['niacinamide', 'arbutin', 'tranexamic', 'glutathione', 'vitamin c'],
  kemerahan: ['panthenol', 'ceramide', 'allantoin', 'centella', 'madecassoside'],
  pori_besar: ['salicylic', 'niacinamide', 'zinc', 'green tea', 'clay'],
  kerutan: ['retinol', 'peptide', 'bakuchiol', 'collagen', 'dna salmon'],
  mata_panda: ['glycolic', 'niacinamide', 'vitamin c', 'hyaluronic', 'caffeine', 'peptide'],
};

const DISPLAY_NAMES: Record<string, string> = {
  jerawat: 'Jerawat Aktif',
  flek_hitam: 'Flek Hitam & Bekas Jerawat',
  kemerahan: 'Kemerahan & Kulit Sensitif',
  pori_besar: 'Pori-pori Membesar',
  kerutan: 'Garis Halus & Penuaan',
  mata_panda: 'Lingkaran Hitam Mata',
};

export function matchProducts(
  products: Product[],
  skinType: string,
  concerns: Record<string, number>
): MatchedProduct[] {
  if (!products || !products.length) return [];

  const matched = products.map((product) => {
    let score = product.tipe.includes(skinType) ? 1.5 : 0.2;
    const reasons: string[] = [];

    for (const [concern, prob] of Object.entries(concerns)) {
      if (!product.target.includes(concern)) continue;

      const weight = product.bobot?.[concern] ?? 1.25;
      score += prob * weight;

      const matchingIngredients = (product.bahan_keywords || []).filter((kw) =>
        (INGREDIENTS_MAP[concern] || []).some(
          (ing) => ing.includes(kw) || kw.includes(ing)
        )
      );

      const concernLabel = DISPLAY_NAMES[concern] || concern;
      if (matchingIngredients.length > 0) {
        reasons.push(
          `${concernLabel} (${matchingIngredients.slice(0, 2).join(', ')})`
        );
      } else {
        reasons.push(concernLabel);
      }
    }

    return {
      ...product,
      score: Math.round(score * 100) / 100,
      reasons,
    };
  });

  return matched.sort((a, b) => b.score - a.score);
}
