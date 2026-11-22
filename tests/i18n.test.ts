import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WeightLossBuilder } from "../src/WeightLossBuilder";
import { describe, expect, it, vi } from "vitest";
import { getLanguage, languages, uiText } from "../src/i18n";
import messages from "../src/i18n/uiMessages.json";

describe("interface translations", () => {
  it("has all seven translations and preserves interpolation placeholders", () => {
    for (const [key, variants] of Object.entries(messages)) {
      expect(variants.length, key).toBe(Object.keys(languages).length - 1);
      const placeholders = (text: string) =>
        text.match(/\{\w+\}/g)?.sort() ?? [];
      for (const variant of variants) {
        expect(variant.trim(), key).toBeTruthy();
        expect(placeholders(variant), key).toEqual(placeholders(key));
      }
    }
  });

  it("uses the selected locale, localizes built-in titles, and preserves user text", () => {
    vi.stubGlobal("localStorage", { getItem: () => "pt-PT" });
    try {
      expect(getLanguage()).toBe("pt");
      expect(uiText(" Pause workout ")).not.toBe(" Pause workout ");
      expect(uiText("Previous {v0}", ["5"])).toContain("5");
      expect(uiText("15 min · Easy walk", [], true)).not.toBe(
        "15 min · Easy walk",
      );
      expect(uiText("Save", [], true)).toBe("Save");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("keeps equipment option values stable when the labels are translated", () => {
  vi.stubGlobal("localStorage", { getItem: () => "pt" });
  try {
    const markup = renderToStaticMarkup(
      createElement(WeightLossBuilder, {
        initialKind: "Bike",
        onCreate: () => {},
      }),
    );
    expect(markup).toContain(
      '<option value="Bike" selected="">Bicicleta</option>',
    );
    expect(markup).toContain('<option value="Rower">Remo</option>');
  } finally {
    vi.unstubAllGlobals();
  }
});
