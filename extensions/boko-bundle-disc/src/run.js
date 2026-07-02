// @ts-check
import { DiscountApplicationStrategy } from "../generated/api";

const EMPTY_DISCOUNT = {
  discountApplicationStrategy: DiscountApplicationStrategy.First,
  discounts: [],
};

export function run(input) {
  let percentage = 10;
  let minItems = 2;
  try {
    const cfg = JSON.parse(
      (input && input.discountNode && input.discountNode.metafield && input.discountNode.metafield.value) || "{}"
    );
    if (cfg.percentage != null) percentage = Number(cfg.percentage);
    if (cfg.minItems != null) minItems = Number(cfg.minItems);
  } catch (e) {}

  const lines = (input && input.cart && input.cart.lines) || [];
  const bundleLines = lines.filter((l) => l.bundle && l.bundle.value);
  const totalQty = bundleLines.reduce((s, l) => s + (l.quantity || 0), 0);

  if (bundleLines.length === 0 || totalQty < minItems || !(percentage > 0)) {
    return EMPTY_DISCOUNT;
  }

  return {
    discountApplicationStrategy: DiscountApplicationStrategy.First,
    discounts: [
      {
        message: "Bundle " + percentage + "% off",
        targets: bundleLines.map((l) => ({ cartLine: { id: l.id } })),
        value: { percentage: { value: String(percentage) } },
      },
    ],
  };
}
